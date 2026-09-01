import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, isOn, parseFields, parseState } from '../../../scpi/values.ts';
import {
	applied,
	clamped,
	compare,
	flag,
	inputs,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { type Channel, reading, type ScpiScope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { advancedTypes, paired, sources } from './measure.ts';

const MODE = ':CURSor:MODE';
const MITEM = ':CURSor:MITem';

const modes = ['TRACk', 'MANual', 'MEASure'] as const;
const manualTypes = ['X', 'Y', 'XY'] as const;
const tagStyles = ['FIXed', 'FOLLowing'] as const;
const xReferences = ['DELay', 'POSition'] as const;
const yReferences = ['OFFSet', 'POSition'] as const;

const PICOSECOND = 1e-12;
const MICROVOLT = 1e-6;
// The guide bounds X by the time base ([-horizontal_grid/2*timebase+horizontal_delay, ...], p. 83) and Y by the
// vertical scale and offset (p. 87), both of which follow settings this tool does not read; these keep a value inside
// what a position can mean at all and leave the rest to the scope, which moves what it cannot take to the nearest
// value it can and comes back as a warning.
const xValue = z.number().min(-1e4).max(1e4);
const yValue = z.number().min(-1e6).max(1e6);

// The measurement sources, except that the cursor takes one DIGital source for the whole logic pod rather than the
// per-line D<d>, and adds the histogram.
const [head, ...tail] = sources;
const traces: [string, ...string[]] = [
	head,
	...tail.filter((source) => !/^Z?D\d+$/.test(source)),
	'DIGital',
	'HISTOGram',
];
const traceValue = z.enum(traces);
const trackless = ['DIGital', 'HISTOGram'];

const placed = (name: string, mnemonic: string, schema: z.ZodType, what: string, floor: number): Param => ({
	...clamped(name, mnemonic, schema, what, asQuantity, floor),
	wire: nr3,
});

const enabled = flag('cursors', ':CURSor', 'the cursor function itself', isOn);

// :CURSor:MODE carries the manual cursor type as a second field, which is why mode and manual_type are two public
// fields that travel as one line; every other row is one parameter, one command.
const modeRows: Param[] = [
	param(
		'mode',
		MODE,
		z.enum(modes),
		'Manual places both cursors by hand. Track ties them to the source waveforms. Measure ties them to the advanced measurement named by measure_item.',
	),
	param(
		'manual_type',
		MODE,
		z.enum(manualTypes),
		'Which manual cursors are shown. X selects the two vertical cursors, Y selects the two horizontal cursors and XY selects all four. Requires Manual mode',
	),
];

const measureItem: Param = {
	...param(
		'measure_item',
		MITEM,
		z.object({
			type: z.enum(advancedTypes),
			source1: z.enum(sources),
			source2: z.enum(sources).optional(),
		}),
		'Advanced measurement used by Measure mode. source2 applies only to two-source measurement types',
		(raw) => {
			const [type = '', source1 = '', source2] = parseFields(raw);
			return { type, source1, ...(source2 === undefined ? {} : { source2 }) };
		},
	),
	wire: (value) => {
		const { type, source1, source2 } = value as { type: string; source1: string; source2?: string };
		return [type, source1, ...(source2 ? [source2] : [])].join(',');
	},
};

const source1 = param('source1', ':CURSor:SOURce1', traceValue, 'the trace cursor 1 belongs to', (raw) =>
	asState(raw, traces),
);
// Writable in every mode, read only in Track mode: the query hung right after SOURce1 answered on an SDS1204X HD,
// and Track is the one mode that displays a second source. Whether the query answers there is untested.
const source2 = param(
	'source2',
	':CURSor:SOURce2',
	traceValue,
	'Trace cursor 2 belongs to. Read back in Track mode only',
	(raw) => asState(raw, traces),
);

const rows: Param[] = [
	param(
		'tag_style',
		':CURSor:TAGStyle',
		z.enum(tagStyles),
		'Where cursor value tags are drawn. Fixed keeps them in place and Following moves them with the trace',
		(raw) => asState(raw, tagStyles),
	),
	source1,
	source2,
	param(
		'x_reference',
		':CURSor:XREFerence',
		z.enum(xReferences),
		'What stays fixed while the timebase changes. Delay keeps the cursor value, so the cursor moves on screen. Position keeps the cursor in place while the waveform expands around it.',
		(raw) => asState(raw, xReferences),
	),
	param(
		'y_reference',
		':CURSor:YREFerence',
		z.enum(yReferences),
		'What stays fixed while the vertical scale changes. Offset keeps the cursor value, so the cursor moves on screen. Position keeps the cursor in place.',
		(raw) => asState(raw, yReferences),
	),
	placed('x1', ':CURSor:X1', xValue, 'position of cursor X1 in seconds from the trigger', PICOSECOND),
	placed('x2', ':CURSor:X2', xValue, 'position of cursor X2 in seconds from the trigger', PICOSECOND),
	placed('y1', ':CURSor:Y1', yValue, 'position of cursor Y1 in volts', MICROVOLT),
	placed('y2', ':CURSor:Y2', yValue, 'position of cursor Y2 in volts', MICROVOLT),
];

const analog = /^[CZ](\d)$/;

function gate(scope: ScpiScope, source: unknown): void {
	if (typeof source !== 'string') return;
	const channel = analog.exec(source)?.[1];
	if (channel) scope.requireChannel(`C${channel}` as Channel);
	else if (source === 'DIGital') {
		scope.warn('Digital sources require the MSO option. Option availability is not known');
	} else scope.warn(`Whether ${source} carries a waveform is not known. The source is used as requested`);
}

async function readMode(session: ScpiSession): Promise<Values> {
	const raw = await session.query(`${MODE}?`);
	const [mode = '', type] = parseFields(raw);
	return {
		mode: parseState(mode, modes) ?? { raw },
		...(type === undefined ? {} : { manual_type: parseState(type, manualTypes) ?? { raw } }),
	};
}

const readRows = rows.filter((row) => row !== source2);
// The position queries never answer while the cursors are off, observed on an SDS1204X HD right after every state
// query above them answered, so they are read only while the cursors are on.
const positions = new Set(['x1', 'x2', 'y1', 'y2']);
const stateRows = readRows.filter((row) => !positions.has(row.name));
const positionRows = readRows.filter((row) => positions.has(row.name));

const readSource2 = async (session: ScpiSession, mode: unknown): Promise<Values> =>
	mode === 'TRACk' ? readback(session, [source2]) : {};

const PLACEHOLDER = 'a cursor the scope is not displaying answers a placeholder instead of a value';

const read = (session: ScpiSession, scope: ScpiScope, mnemonic: string) =>
	session.query(`${mnemonic}?`).then((raw) => reading(scope, 'A cursor position', raw, PLACEHOLDER));

function announce(scope: ScpiScope, state: Values): void {
	if (state.cursors !== true) {
		scope.warn('The cursors are off, so the returned positions are not displayed');
	} else if (state.mode === 'MANual' && state.manual_type !== 'XY') {
		scope.warn(
			`Only the ${String(state.manual_type)} manual cursors are displayed. The other pair contains retained values`,
		);
	}
}

export const cursorTools = [
	tool({
		name: 'get_cursors',
		description:
			'Read the cursor mode, style, sources, expansion settings and X/Y positions in seconds and volts. Measurement items are included in Measure mode. The second cursor source is read in Track mode only, because its query does not answer in the other modes. Use measure_cursors for deltas and reciprocal frequency.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state: Values = { ...(await readback(session, [enabled])), ...(await readMode(session)) };
				Object.assign(state, await readback(session, stateRows), await readSource2(session, state.mode));
				if (state.cursors === true) Object.assign(state, await readback(session, positionRows));
				else {
					scope.warn(
						'The cursors are off. The positions were not read because their queries do not answer while the cursors are off, and the returned settings are retained values',
					);
				}
				if (state.mode === 'MEASure') Object.assign(state, await readback(session, [measureItem]));
				return state;
			}),
	}),
	tool({
		name: 'configure_cursors',
		description:
			'Set the cursor mode, measurement item, style, sources, expansion settings and X/Y positions, then read back the requested values. Manual type applies only to Manual mode. source2 applies only to two-source measurement types. Track mode does not support Digital or Histogram sources. The second cursor source is written in every mode and read back in Track mode only, because its query does not answer in the other modes. Positions adjusted by the scope are returned with a warning. Support for non-analog sources cannot be determined before use.',
		input: z
			.strictObject({
				...inputs([enabled]),
				...inputs(modeRows),
				...inputs([measureItem]),
				...inputs(rows),
			})
			.superRefine((input: Values, ctx) => {
				if (input.manual_type !== undefined && input.mode !== 'MANual') {
					const message = 'manual_type requires Manual mode. Remove it or set mode to Manual';
					ctx.addIssue({ code: 'custom', message, path: ['manual_type'] });
				}
				const item = input.measure_item as { type: string; source2?: string } | undefined;
				if (item?.source2 !== undefined && !paired.includes(item.type)) {
					const message = 'source2 requires a two-source measurement type. Remove it or choose a compatible type';
					ctx.addIssue({ code: 'custom', message, path: ['measure_item', 'source2'] });
				}
				for (const name of ['source1', 'source2']) {
					if (input.mode === 'TRACk' && trackless.includes(String(input[name]))) {
						const message =
							'Track mode does not support Digital or Histogram sources. Choose another source or use a compatible mode';
						ctx.addIssue({ code: 'custom', message, path: [name] });
					}
				}
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(
				...settings([enabled], input),
				input.mode !== undefined && `${MODE} ${input.mode}${input.manual_type ? `,${input.manual_type}` : ''}`,
				...settings([measureItem], input),
				...settings(rows, input),
			);
			return scope.execute(async (session) => {
				gate(scope, input.source1);
				gate(scope, input.source2);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(await readback(session, applied([enabled], input))),
					...(input.mode === undefined ? {} : await readMode(session)),
					...(await readback(session, applied([measureItem], input))),
					...(await readback(session, applied(stateRows, input))),
				};
				const wantedPositions = applied(positionRows, input);
				if (wantedPositions.length > 0) {
					const on = input.cursors ?? state.cursors ?? (await readback(session, [enabled])).cursors;
					if (on === true) Object.assign(state, await readback(session, wantedPositions));
					else {
						scope.warn(
							'The positions were written and not read back. Their queries do not answer while the cursors are off',
						);
					}
				}
				if (input.source2 !== undefined) {
					const mode = state.mode ?? (await readMode(session)).mode;
					Object.assign(state, await readSource2(session, mode));
					if (!('source2' in state)) {
						scope.warn('source2 was written and not read back. Its query does not answer outside Track mode');
					}
				}
				compare(scope, [enabled, ...modeRows, ...rows], input, state, 'a position is clamped to what is on screen');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'measure_cursors',
		description:
			'Read both cursor positions, their horizontal and vertical differences and the reciprocal horizontal difference. Also returns the cursor mode and sources. The second cursor source is read in Track mode only, because its query does not answer in the other modes. Nonnumeric values are preserved as raw text. Cursors that are off or hidden by the current manual mode return a warning.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state: Values = { ...(await readback(session, [enabled])), ...(await readMode(session)) };
				announce(scope, state);
				return {
					...state,
					...(await readback(session, [source1])),
					...(await readSource2(session, state.mode)),
					horizontal: {
						cursor_a: await read(session, scope, ':CURSor:X1'),
						cursor_b: await read(session, scope, ':CURSor:X2'),
						delta_time: await read(session, scope, ':CURSor:XDELta'),
						frequency: await read(session, scope, ':CURSor:IXDelta'),
					},
					vertical: {
						cursor_a: await read(session, scope, ':CURSor:Y1'),
						cursor_b: await read(session, scope, ':CURSor:Y2'),
						delta_voltage: await read(session, scope, ':CURSor:YDELta'),
					},
				};
			}),
	}),
];
