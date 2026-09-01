import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantities, asQuantity, parseFields, parseKeyValues, parseState } from '../../../scpi/values.ts';
import { type Channel, type Scope, UnsupportedError } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { channel, timeValue, voltageValue } from './schema.ts';

const cursors = ['VREF', 'VDIF', 'TREF', 'TDIF', 'HREF', 'HDIF'] as const;
const cursorTypes = ['X', 'Y', 'X-Y'] as const;
const modes = ['off', 'manual', 'track'] as const;
type Mode = (typeof modes)[number];

const namedModes = { off: 'OFF', manual: 'MANUAL', track: 'TRACK' } as const;
const switchModes = { manual: 'OFF', track: 'ON' } as const;

function cursorFormat(scope: Scope): boolean {
	const support = scope.capabilities?.features.xe;
	if (support === 'unknown') {
		scope.warn(
			`The cursor mode format of ${scope.identity?.model} is unknown. Assuming Off or On, where Off selects Manual mode.`,
		);
	}
	return support === 'supported';
}

const decodedModes = { OFF: 'off', MANUAL: 'manual', TRACK: 'track' } as const;

function encodeMode(mode: Mode, named: boolean, scope: Scope): string {
	if (named) return `CRMS ${namedModes[mode]}`;
	if (mode === 'off') {
		throw new UnsupportedError(
			`${scope.identity?.model} supports Manual and Track cursor modes but cannot close the cursors through this command.`,
		);
	}
	return `CRMS ${switchModes[mode]}`;
}

function decodeMode(raw: string, named: boolean): Mode | undefined {
	const state = parseState(raw, named ? (['OFF', 'MANUAL', 'TRACK'] as const) : (['OFF', 'ON'] as const));
	if (state === undefined) return undefined;
	if (state === 'ON') return 'track';
	return named ? decodedModes[state] : 'manual';
}

async function readPositions(session: ScpiSession, source: Channel, names: readonly string[]) {
	const raw: string[] = [];
	for (let index = 0; index < names.length; index += 4) {
		raw.push(await session.query(`${source}:CRST? ${names.slice(index, index + 4).join(',')}`));
	}
	const fields = Object.assign({}, ...raw.map((line) => parseKeyValues(line))) as Record<string, string>;
	return { values: asQuantities(fields), raw };
}

type Wanted = { mode: boolean; type: boolean; positions: boolean };

const everything: Wanted = { mode: true, type: true, positions: true };

// `only` limits the read-back to what a request set; without it the whole cursor state is read.
async function readCursors(
	session: ScpiSession,
	named: boolean,
	source?: Channel,
	names: readonly string[] = cursors,
	only: Wanted = everything,
) {
	const mode = only.mode ? await session.query('CRMS?') : undefined;
	const type = only.type ? await session.query('CRTY?') : undefined;
	return {
		...(mode === undefined ? {} : { mode: { mode: decodeMode(mode, named), raw: mode } }),
		...(type === undefined ? {} : { type: { type: parseState(type, cursorTypes), raw: type } }),
		...(source && only.positions ? { source, positions: await readPositions(session, source, names) } : {}),
	};
}

function parseCursorValue(measurement: 'HREL' | 'VREL', raw: string) {
	const [first, second, third, fourth] = parseFields(raw, measurement).map(asQuantity);
	return measurement === 'HREL'
		? { delta_time: first, frequency: second, cursor_a: third, cursor_b: fourth, raw }
		: { delta_voltage: first, cursor_a: second, cursor_b: third, raw };
}

const positions = z.object({
	VREF: voltageValue.optional().describe('Y1 (curA) voltage, manual mode'),
	VDIF: voltageValue.optional().describe('Y2 (curB) voltage, manual mode'),
	TREF: timeValue.optional().describe('X1 (curA) time, manual mode'),
	TDIF: timeValue.optional().describe('X2 (curB) time, manual mode'),
	HREF: timeValue.optional().describe('X1 (curA) time, track mode'),
	HDIF: timeValue.optional().describe('X2 (curB) time, track mode'),
});

export const cursorTools = [
	tool({
		name: 'get_cursors',
		description:
			'Read the cursor mode, manual cursor type, and all six cursor positions for a trace. Older families support only Manual and Track modes and cannot report an Off state.',
		input: z.strictObject({ source: channel.default('C1').describe('Trace the cursor positions are relative to') }),
		annotations: readOnly,
		handler: ({ source }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(source);
				return readCursors(session, cursorFormat(scope), source);
			}),
	}),
	tool({
		name: 'configure_cursors',
		description:
			'Set the cursor mode, manual cursor type, and up to four cursor positions for one trace. Cursor positions require a unit. Their range depends on the grid, time per division, and volts per division, so the scope may clamp them.',
		input: z
			.object({
				mode: z
					.enum(modes)
					.optional()
					.describe('Off closes the cursors on SDS1000X-E. Manual and Track select the cursor mode.'),
				type: z.enum(cursorTypes).optional().describe('Manual cursor type. Ignored in Track mode.'),
				source: channel.optional().describe('Trace the cursor positions are relative to'),
				positions: positions.optional().describe("Cursor positions with unit, e.g. { TREF: '-3US', VDIF: '-500MV' }"),
			})
			.refine(({ source, positions }) => !positions || source, {
				message: 'positions require a source channel',
				path: ['source'],
			})
			.refine(({ positions }) => Object.keys(positions ?? {}).length <= 4, {
				message: 'at most four cursor positions per command',
				path: ['positions'],
			}),
		annotations: mutating,
		handler: ({ mode, type, source, positions }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (source) scope.requireChannel(source);
				const named = cursorFormat(scope);
				const names = cursors.filter((name) => positions?.[name]);
				const commands = plan(
					mode && encodeMode(mode, named, scope),
					type && `CRTY ${type}`,
					names.length > 0 && `${source}:CRST ${names.map((name) => `${name},${positions?.[name]}`).join(',')}`,
				);
				for (const command of commands) await session.command(command);
				const state = await readCursors(session, named, source, names, {
					mode: mode !== undefined,
					type: type !== undefined,
					positions: names.length > 0,
				});
				return { commands, state };
			}),
	}),
	tool({
		name: 'measure_cursors',
		description:
			'Read cursor measurements for a trace. Horizontal measurements return the time difference, reciprocal frequency, and both cursor times. Vertical measurements return the voltage difference and both cursor voltages. Non-SPO models return only the difference.',
		input: z.object({
			source: channel,
			measurement: z.enum(['HREL', 'VREL']).describe('Horizontal time cursors or vertical voltage cursors.'),
		}),
		annotations: readOnly,
		handler: ({ source, measurement }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(source);
				scope.requireLegacyDialect();
				const raw = await session.query(`${source}:CRVA? ${measurement}`);
				return { source, measurement, ...parseCursorValue(measurement, raw) };
			}),
	}),
];
