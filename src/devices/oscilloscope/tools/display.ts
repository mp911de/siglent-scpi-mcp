import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { parseKeyValues, parseQuantity, stripHeader } from '../../../scpi/values.ts';
import {
	applied,
	compare,
	flag,
	inputs,
	pairs,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import type { Scope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const MINIMUM = 30;

const isOn = (raw: string): boolean => stripHeader(raw).toUpperCase() === 'ON';

// DTJN reads inverted: ON shows dots, OFF draws the vectors that join the points (p. 83).
const joined = (raw: string): boolean => !isOn(raw);

const level = z.number().int().min(0).max(100);

const interpolation = [
	flag('join_points', 'DTJN', 'Draw interpolation lines between sample points. Disable to show dots.', joined),
];

const params = [
	param('grid', 'GRDS', z.enum(['FULL', 'HALF', 'OFF']), 'graticule type', stripHeader),
	flag('menu', 'MENU', 'show the on-screen menu', isOn),
	param(
		'persistence',
		'PESU',
		z.literal(['OFF', 'INFINITE', 1, 5, 10, 30]),
		'Persistence duration in seconds. Off is available only on SDS1000X-E.',
		stripHeader,
	),
];

const intensity = [
	param('grid_intensity', 'GRID', level, 'graticule brightness in percent'),
	param('trace_intensity', 'TRACE', level, 'trace brightness in percent'),
];

const all = [...interpolation, ...params, ...intensity];

const percent = (value?: string): unknown => (value === undefined ? undefined : (parseQuantity(value)?.value ?? value));

async function readIntensity(session: ScpiSession): Promise<Values> {
	const raw = await session.query('INTS?');
	const fields = parseKeyValues(raw);
	return { ...Object.fromEntries(intensity.map((p) => [p.name, percent(fields[p.mnemonic])])), intensity_raw: raw };
}

// `only` limits the read-back to what a request set; without it the whole display is read. Both intensities travel in
// one INTS command, so they come back together.
export async function readDisplay(session: ScpiSession, only?: Values): Promise<Values> {
	const rows = only ? applied(all, only) : all;
	const levels = only === undefined || intensity.some(({ name }) => only[name] !== undefined);
	return { ...(await readback(session, rows)), ...(levels ? await readIntensity(session) : {}) };
}

function warnMinimum(scope: Scope, input: Values): void {
	const low = intensity.filter((p) => Number(input[p.name]) < MINIMUM).map((p) => p.name);
	if (low.length > 0) {
		scope.warn(`${low.join(' and ')} below ${MINIMUM} may be clamped by this model.`);
	}
}

export const displayTools = [
	tool({
		name: 'get_display',
		description:
			'Read the display configuration, including interpolation, graticule, menu visibility, persistence, and grid and trace intensity.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				return readDisplay(session);
			}),
	}),
	tool({
		name: 'configure_display',
		description:
			'Configure display interpolation, graticule, menu visibility, persistence, and grid and trace intensity. Low intensity values may be clamped. Disabling persistence is available only on SDS1000X-E.',
		input: z.object(inputs(all)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const levels = pairs(intensity, input);
			const commands = plan(
				input.join_points !== undefined && `DTJN ${onOff(!input.join_points)}`,
				...settings(params, input),
				levels !== '' && `INTS ${levels}`,
			);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (input.persistence === 'OFF') scope.requireSupport('xe');
				warnMinimum(scope, input);
				for (const command of commands) await session.command(command);
				const state = await readDisplay(session, input);
				compare(scope, all, input, state);
				return { commands, state };
			});
		},
	}),
];
