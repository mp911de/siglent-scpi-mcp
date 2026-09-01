import * as z from 'zod';
import { readAtLeast } from '../../../scpi/codec.ts';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, parseQuantity, parseState, stripHeader } from '../../../scpi/values.ts';
import { applied, compare, flag, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Support } from '../models.ts';
import { type Scope, UnsupportedError } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { timeoutMs } from './schema.ts';

const states = ['ON', 'OFF'] as const;
const state = (raw: string) => asState(raw, states);

const mode = flag(
	'enabled',
	'HSMD',
	'History mode on or off. A frame and the history list require it to be on.',
	state,
);
const frame = param(
	'frame',
	'FRAM',
	z.int().min(0),
	'frame to show, 0 to the newest frame the scope holds',
	asQuantity,
);
const gated = [frame, flag('list', 'HSLST', 'show the history list next to the waveform', state)];
const params = [mode, ...gated];

const TIMESTAMP_BYTES = 8;
const TIMESTAMP_TIMEOUT = 5_000;
const clock = /^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*\.\s*(\d+)$/;

const named = (scope: Scope) => `${scope.identity?.model ?? 'The scope'} (${scope.capabilities?.family ?? 'unknown'})`;

const support = (scope: Scope): Support =>
	scope.capabilities?.dialect === 'legacy' ? scope.capabilities.features.xe : 'unknown';

function parseClock(raw: string) {
	const [, hour, minute, second, microsecond] = clock.exec(stripHeader(raw)) ?? [];
	if (hour === undefined) return undefined;
	return {
		format: 'text',
		hour: Number(hour),
		minute: Number(minute),
		second: Number(second),
		microsecond: Number(microsecond),
		raw,
	};
}

// Only SDS1000X-E is known to answer the textual format 1 (p. 91). Every other family, recognized or not, is read as
// bytes: format 2 read as line text holds no line feed, so it would block until the timeout and drop the connection.
async function readTimestamp(session: ScpiSession, scope: Scope, timeout?: number) {
	if (support(scope) === 'supported') {
		const raw = await session.query('FTIM?', timeout);
		return parseClock(raw) ?? { format: 'text', raw };
	}
	if (support(scope) === 'unknown') {
		scope.warn(
			`${named(scope)} has an unknown timestamp format. The timestamp is read as bytes and decoded as text when possible.`,
		);
	}
	const payload = await session.queryBinary('FTIM?', timeout ?? TIMESTAMP_TIMEOUT, readAtLeast(TIMESTAMP_BYTES));
	const text = parseClock(payload.toString('latin1').trim());
	if (text) return text;
	scope.warn(
		`${named(scope)} returned an unknown ${payload.length}-byte timestamp. It is returned undecoded as hexadecimal.`,
	);
	return { format: 'binary', length: payload.length, hex: payload.toString('hex') };
}

function queryable(scope: Scope, sending = false): boolean {
	const available = support(scope) !== 'unsupported';
	if (available || sending) scope.requireSupport('xe');
	return available;
}

async function requireHistoryOn(session: ScpiSession, scope: Scope, enabling: boolean): Promise<string | undefined> {
	const raw = await session.query('HSMD?');
	const on = parseState(raw, states);
	if (on === 'OFF' && !enabling) {
		throw new UnsupportedError(
			'History mode is off. Set enabled to true in the same request before selecting a frame or showing the history list.',
		);
	}
	if (on === undefined) {
		scope.warn(
			`The history mode response ${JSON.stringify(raw)} was not recognized. Frame and list settings were sent unchecked.`,
		);
	}
	return on;
}

// FRAM? answers the max frame only the first time history is turned on, and the current frame on every later
// enable (p. 89), so an out-of-range frame can only be reported, not rejected.
async function frameOnEnable(session: ScpiSession, scope: Scope, frame: number) {
	const raw = await session.query('FRAM?');
	const reported = parseQuantity(raw)?.value;
	if (reported !== undefined && frame > reported) {
		scope.warn(`Frame ${frame} may be outside the available history range reported as ${JSON.stringify(raw)}.`);
	}
	return asQuantity(raw);
}

export const historyTools = [
	tool({
		name: 'get_history',
		description:
			'Read history mode, the current frame, history-list visibility, and the current frame timestamp. Full history state is available only on SDS1000X-E. Other families return the timestamp as hexadecimal unless it can be decoded as text.',
		input: z.object({
			timeout_ms: timeoutMs.describe('Timestamp read timeout in milliseconds. Binary timestamps default to 5000.'),
		}),
		annotations: readOnly,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const known = queryable(scope);
				if (!known) {
					scope.warn(`${named(scope)} supports only reading the frame timestamp. Other history state is unavailable.`);
				}
				return {
					...(known ? await readback(session, params) : {}),
					timestamp: await readTimestamp(session, scope, timeout_ms),
				};
			}),
	}),
	tool({
		name: 'configure_history',
		description:
			'Turn history mode on or off, select a frame, and show or hide the history list. Selecting a frame or showing the list requires history mode. The scope may clamp unavailable frame numbers. On models outside SDS1000X-E, frame selection is sent without verification.',
		input: z
			.object(inputs(params))
			.refine(({ enabled, frame, list }) => enabled !== false || (frame === undefined && list === undefined), {
				message: 'Frame selection and the history list require history mode. Do not disable it in the same request.',
				path: ['enabled'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const { enabled, list } = input;
			const selected = input.frame as number | undefined;
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const known = queryable(scope, enabled !== undefined || list !== undefined);
				if (!known) {
					scope.warn(`${named(scope)} cannot verify history mode or frame selection. The frame was sent unchecked.`);
				}
				const gating = selected !== undefined || list !== undefined;
				const before = known && gating ? await requireHistoryOn(session, scope, enabled === true) : undefined;
				for (const command of settings([mode], input)) await session.command(command);
				const onEnable =
					before === 'OFF' && selected !== undefined ? await frameOnEnable(session, scope, selected) : undefined;
				for (const command of settings(gated, input)) await session.command(command);
				const state = known ? await readback(session, applied(params, input)) : undefined;
				if (state) compare(scope, [frame], input, state, 'the frames it holds depend on the acquisitions in memory');
				return { commands, ...(onEnable && { frame_on_enable: onEnable }), ...(state && { state }) };
			});
		},
	}),
];
