import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import {
	asQuantity,
	asState,
	isOn,
	parseFields,
	parseState,
	quoted,
	stripHeader,
	unquote,
} from '../../../scpi/values.ts';
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
import { type Channel, channels, counted, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const GVALUE = ':FUNCtion:GVALue';
const MODE = ':FUNCtion<x>:FFT:MODE';
const AUTOSET = ':FUNCtion<x>:FFT:AUToset';
const RESET = ':FUNCtion<x>:FFT:RESET';
const SEARCH = ':FUNCtion<x>:FFT:SEARch';
const RESULT = ':FUNCtion<x>:FFT:SEARch:RESult';

const operations = [
	'ADD',
	'SUBTract',
	'MULTiply',
	'DIVision',
	'INTegrate',
	'DIFF',
	'FFT',
	'SQRT',
	'ERES',
	'AVERage',
	'ABSolute',
	'SIGN',
	'IDENtity',
	'NEGation',
	'EXP',
	'TEN',
	'LN',
	'LOG',
	'INTErpolate',
	'MAXHold',
	'MINHold',
	'FILTer',
] as const;

const filterTypes = ['LPASs', 'HPASs', 'BPASs', 'BREJect'] as const;
const banded = ['BPASs', 'BREJect'];
const displays = ['SPLit', 'FULL', 'EXCLusive'] as const;
const fftUnits = ['DBVrms', 'Vrms', 'DBm'] as const;
const fftWindows = ['RECTangle', 'BLACkman', 'HANNing', 'HAMMing', 'FLATtop'] as const;
const fftModes = ['NORMal', 'MAXHold', 'AVERage'] as const;
const searches = ['OFF', 'PEAK', 'MARKer'] as const;
const autosets = ['SPAN', 'PEAK', 'NORMal'] as const;
const resultTypes = ['Peaks', 'Markers'] as const;
// The union of every per-model set the guide prints (p. 243); the scope's own clamp comes back as a warning.
const fftPoints = [
	'1k',
	'2k',
	'4k',
	'8k',
	'16k',
	'32k',
	'64k',
	'128k',
	'256k',
	'512k',
	'1M',
	'2M',
	'4M',
	'8M',
	'16M',
	'32M',
] as const;
const averages = [4, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;

const numbered = (prefix: string): string[] => Array.from({ length: 4 }, (_, index) => `${prefix}${index + 1}`);

// <x> and <m> are "# math functions" and "# memory waveforms", which the guide never puts a number to, so four of
// each is a sanity cap rather than a documented one (p. 269).
const sources = [...channels, ...numbered('Z'), ...numbered('F'), ...numbered('M')] as [string, ...string[]];

const MICROVOLT = 1e-6;
const PICOSECOND = 1e-12;
// The guide bounds a frequency, a scale and a level only by the time base, the source scale, the FFT unit and the
// probe in force (pp. 238, 245, 247, 267). These keep a value inside what the setting can mean at all and leave the
// rest to the scope, which moves what it cannot take to the nearest value it can and comes back as a warning.
const frequency = z.number().min(0).max(1e10);
const vertical = z.number().min(-1e12).max(1e12);
const level = z.number().min(-280).max(1e10);
const gateSeconds = z.number().min(-1e4).max(1e4);

const scaled = (name: string, mnemonic: string, schema: z.ZodType, what: string, floor = MICROVOLT): Param => ({
	...clamped(name, mnemonic, schema, what, asQuantity, floor),
	wire: nr3,
});

const fnIndex = z
	.int()
	.min(1)
	.max(4)
	.default(1)
	.describe(
		'Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap',
	);

const trace = flag('enabled', ':FUNCtion<x>', 'the math function itself', isOn);
const operationRow = param(
	'operation',
	':FUNCtion<x>:OPERation',
	z.enum(operations),
	'The waveform math operation. FFT settings live in get_fft and configure_fft',
	(raw) => asState(raw, operations),
);
const operand = (name: string, mnemonic: string, what: string): Param =>
	param(
		name,
		mnemonic,
		z.enum(sources),
		`${what}: an analog channel, a zoomed trace, another math function or a memory waveform`,
		(raw) => asState(raw, sources),
	);

const sourceRows = [
	operand('source1', ':FUNCtion<x>:SOURce1', 'First operand'),
	operand('source2', ':FUNCtion<x>:SOURce2', 'Second operand, used by the two-source arithmetic operations'),
];

const filterType = param(
	'filter_type',
	':FUNCtion<x>:FILTer:TYPe',
	z.enum(filterTypes),
	'Filter operation type: low pass, high pass, band pass or band reject',
	(raw) => asState(raw, filterTypes),
);
const filterUpper = scaled(
	'filter_upper',
	':FUNCtion<x>:FILTer:HFRequency',
	frequency,
	'Upper filter frequency in hertz. Used only by band pass and band reject',
	1,
);
const filterLower = scaled(
	'filter_lower',
	':FUNCtion<x>:FILTer:LFRequency',
	frequency,
	'Lower filter frequency in hertz',
	1,
);

const specific: Record<string, Param[]> = {
	AVERage: [
		param(
			'average_count',
			':FUNCtion<x>:AVERage:NUM',
			z.literal(averages),
			'Sweeps of the Average operation. The SDS800X HD, SDS1000X HD and SDS2000X Plus stop at 1024',
			counted('average_count'),
		),
	],
	DIFF: [
		param(
			'diff_dx',
			':FUNCtion<x>:DIFF:DX',
			z.int().min(1).max(1_000_000),
			'Step size of the Diff operation in samples. The accepted range is unknown',
			counted('diff_dx'),
		),
	],
	ERES: [
		{
			...param(
				'eres_bits',
				':FUNCtion<x>:ERES:BITS',
				z.literal([0.5, 1, 1.5, 2, 2.5, 3]),
				'Enhancement of the Eres operation in bits',
				asQuantity,
			),
			wire: (value) => Number(value).toFixed(1),
		},
	],
	FILTer: [filterType, filterUpper, filterLower],
	INTegrate: [
		flag(
			'integrate_gate',
			':FUNCtion<x>:INTegrate:GATE',
			'the integration threshold gates positioned by gate_a and gate_b',
			isOn,
		),
		scaled(
			'integrate_offset',
			':FUNCtion<x>:INTegrate:OFFSet',
			z.number().min(-1.67).max(1.67),
			'DC offset of the Integrate operation, -1.67 to 1.67',
		),
	],
	INTErpolate: [
		param(
			'interpolate_factor',
			':FUNCtion<x>:INTErpolate:COEF',
			z.literal([2, 5, 10, 20]),
			'upsample factor of the Interpolate operation',
			counted('interpolate_factor'),
		),
	],
	MAXHold: [
		param(
			'maxhold_sweeps',
			':FUNCtion<x>:MAXHold:SWeeps',
			z.int().min(1).max(2_147_483_646),
			'sweeps limit of the Maxhold operation',
			counted('maxhold_sweeps'),
		),
	],
	MINHold: [
		param(
			'minhold_sweeps',
			':FUNCtion<x>:MINHold:SWeeps',
			z.int().min(1).max(2_147_483_646),
			'sweeps limit of the Minhold operation',
			counted('minhold_sweeps'),
		),
	],
};

const trailer: Param[] = [
	flag('inverted', ':FUNCtion<x>:INVert', 'inversion of the math waveform', isOn),
	scaled(
		'scale',
		':FUNCtion<x>:SCALe',
		vertical,
		'Vertical scale per division of the math trace, whose range follows the source scale, and the time base for Integrate and Diff',
	),
	scaled('position', ':FUNCtion<x>:POSition', vertical, 'vertical position of the math trace in its own unit'),
	{
		...param(
			'label_text',
			':FUNCtion<x>:LABel:TEXT',
			z
				.string()
				.max(20)
				.regex(/^[A-Z0-9 _+.-]*$/, 'up to 20 of A-Z, 0-9, space, underscore, plus, dot or hyphen'),
			'label text, up to 20 characters',
			unquote,
		),
		wire: quoted,
	},
	flag('label', ':FUNCtion<x>:LABel', 'the label on screen', isOn),
];

// The gates run [-horizontal_grid/2*timebase+delay, horizontal_grid/2*timebase+delay] (p. 232), which follows the
// time base in force. The threshold pair is one positional line and global to every function, so it stays out of the
// per-function table.
const gateRows: Param[] = [
	clamped(
		'gate_a',
		GVALUE,
		gateSeconds,
		'Position of integration gate A in seconds. Set with gate_b and never above it',
		asQuantity,
		PICOSECOND,
	),
	clamped('gate_b', GVALUE, gateSeconds, 'position of integration gate B in seconds', asQuantity, PICOSECOND),
];

const opening = [trace, operationRow, ...sourceRows];
const operationRows = Object.values(specific).flat();
const all = [...opening, ...operationRows, ...trailer];
const owned: Array<[string, string]> = [
	...Object.entries(specific).flatMap(([op, rows]) => rows.map(({ name }) => [name, op] as [string, string])),
	['gate_a', 'INTegrate'],
	['gate_b', 'INTegrate'],
];

const at = (x: number, rows: readonly Param[]): Param[] =>
	rows.map((row) => ({ ...row, mnemonic: spot(x, row.mnemonic) }));

const spot = (x: number, mnemonic: string): string => mnemonic.replace('<x>', String(x));

const gvalueOf = (raw: string): Values => {
	const [a, b] = parseFields(raw);
	return { gate_a: asQuantity(a ?? ''), gate_b: asQuantity(b ?? '') };
};

const analog = /^[CZ](\d)$/;

function gateSources(scope: ScpiScope, ...named: unknown[]): void {
	for (const source of named) {
		if (typeof source !== 'string') continue;
		const channel = analog.exec(source)?.[1];
		if (channel) scope.requireChannel(`C${channel}` as Channel);
		if (source.startsWith('Z')) scope.warn(`${source} is a zoomed source and requires zoom to be enabled`);
	}
}

const displayRow = param(
	'display',
	':FUNCtion:FFTDisplay',
	z.enum(displays),
	'How the FFT shares the screen with the source trace: split, full screen or exclusive. This setting is shared by every function',
	(raw) => asState(raw, displays),
);

const fftSource = { ...(sourceRows[0] as Param), name: 'source' };

// The unit goes first because the scale, the reference level and the search values are read in it (pp. 245-252).
const fftHead: Param[] = [
	param(
		'unit',
		':FUNCtion<x>:FFT:UNIT',
		z.enum(fftUnits),
		'Vertical unit of the FFT trace. The scale, reference level and search values follow it',
		(raw) => asState(raw, fftUnits),
	),
	param(
		'load',
		':FUNCtion<x>:FFT:LOAD',
		z.int().min(1).max(1_000_000),
		'External load in ohm the dBm unit converts power against. The scope takes it only while the unit is dBm',
		counted('load'),
	),
	param(
		'window',
		':FUNCtion<x>:FFT:WINDow',
		z.enum(fftWindows),
		'Window function. Rectangle suits transients, Blackman small impulses, Hanning frequency resolution, Flattop amplitude accuracy',
		(raw) => asState(raw, fftWindows),
	),
];

const fftTail: Param[] = [
	param(
		'points',
		':FUNCtion<x>:FFT:POINts',
		z.enum(fftPoints),
		'Maximum FFT points. The set varies by model and ends at 2M on the SDS800X HD class',
		(raw) => asState(raw, fftPoints),
	),
	scaled('span', ':FUNCtion<x>:FFT:SPAN', frequency, 'horizontal span of the FFT in hertz', 1),
	scaled(
		'center_frequency',
		':FUNCtion<x>:FFT:HCENter',
		frequency,
		'Center frequency of the FFT in hertz, whose legal range follows the time base',
		1,
	),
	scaled(
		'vertical_scale',
		':FUNCtion<x>:FFT:SCALe',
		z.number().min(1e-3).max(20),
		'Vertical scale per division in the FFT unit: 0.1 to 20 for dBVrms and dBm, 0.001 to 10 for Vrms',
	),
	scaled(
		'reference_level',
		':FUNCtion<x>:FFT:RLEVel',
		level,
		'Reference level at the top of the FFT grid in the FFT unit, whose range follows the unit and the probe factor',
	),
	param('search', SEARCH, z.enum(searches), 'The FFT search tool: off, a peak table or markers', (raw) =>
		asState(raw, searches),
	),
	scaled(
		'search_excursion',
		':FUNCtion<x>:FFT:SEARch:EXCursion',
		z.number().min(0).max(1e10),
		'minimum rise and fall around a found peak, in the FFT unit',
	),
	scaled(
		'search_threshold',
		':FUNCtion<x>:FFT:SEARch:THReshold',
		level,
		'minimum level a peak must reach, in the FFT unit',
	),
];

const fftRows = [...fftHead, ...fftTail];

const hscale = param('horizontal_scale', ':FUNCtion<x>:FFT:HSCale', z.number(), 'hertz per division', asQuantity);

const modeOf = (raw: string): Values => {
	const [first, count] = parseFields(raw);
	const mode = parseState(first ?? '', fftModes);
	if (!mode) return { mode: { raw } };
	return { mode, ...(count !== undefined && { average_count: counted('average_count')(count) }) };
};

async function guardOperation(session: ScpiSession, scope: ScpiScope, x: number): Promise<void> {
	const op = asState(await session.query(`${spot(x, ':FUNCtion<x>:OPERation')}?`), operations);
	if (op === 'FFT') return;
	scope.warn(
		typeof op === 'string'
			? `Function F${x} runs ${op}, so the FFT settings are stored but stay off screen until its operation is FFT`
			: `The scope returned an unknown math operation ${JSON.stringify(op)}. The FFT settings were sent unchecked`,
	);
}

export const functionTools = [
	tool({
		name: 'get_math',
		description:
			'Read one math function F1-F4: switch, operation, sources, the settings of the active operation, vertical scale and position, inversion and label. FFT settings are read with get_fft.',
		input: z.strictObject({ function: fnIndex }),
		annotations: readOnly,
		handler: ({ function: x }, scope) =>
			scope.execute(async (session) => {
				const state: Values = { function: x, ...(await readback(session, at(x, opening))) };
				const op = state.operation;
				if (typeof op !== 'string') {
					scope.warn(
						`The scope returned an unknown math operation ${JSON.stringify(op)}. Operation-specific settings were not read`,
					);
				} else if (op === 'FILTer') {
					Object.assign(state, await readback(session, at(x, [filterType])));
					const band = banded.includes(String(state.filter_type));
					Object.assign(state, await readback(session, at(x, band ? [filterUpper, filterLower] : [filterLower])));
				} else if (op === 'INTegrate') {
					Object.assign(
						state,
						await readback(session, at(x, specific.INTegrate ?? [])),
						gvalueOf(await session.query(`${GVALUE}?`)),
					);
				} else if (specific[op]) {
					Object.assign(state, await readback(session, at(x, specific[op])));
				}
				return { ...state, ...(await readback(session, at(x, trailer))) };
			}),
	}),
	tool({
		name: 'configure_math',
		description:
			'Set one math function F1-F4 and read back the requested settings. Operation-specific settings need their operation in the same request. FFT settings are configured with configure_fft. Values adjusted by the scope are returned with a warning.',
		input: z
			.strictObject({ function: fnIndex, ...inputs(all), ...inputs(gateRows) })
			.superRefine((input: Values, ctx) => {
				for (const [name, op] of owned) {
					if (input[name] !== undefined && input.operation !== op) {
						ctx.addIssue({
							code: 'custom',
							message: `${name} applies to the ${op} operation. Set operation to ${op} in the same request`,
							path: [name],
						});
					}
				}
				if (input.filter_upper !== undefined && !banded.includes(String(input.filter_type))) {
					ctx.addIssue({
						code: 'custom',
						message: 'filter_upper applies to the BPASs and BREJect filter types. Set filter_type accordingly',
						path: ['filter_upper'],
					});
				}
				if ((input.gate_a === undefined) !== (input.gate_b === undefined)) {
					ctx.addIssue({
						code: 'custom',
						message: 'gate_a and gate_b position one gate pair and are set together',
						path: [input.gate_a === undefined ? 'gate_a' : 'gate_b'],
					});
				}
				if (typeof input.gate_a === 'number' && typeof input.gate_b === 'number' && input.gate_a > input.gate_b) {
					ctx.addIssue({ code: 'custom', message: 'gate_a cannot lie above gate_b', path: ['gate_a'] });
				}
				for (const name of ['source1', 'source2']) {
					if (input[name] === `F${input.function}`) {
						ctx.addIssue({
							code: 'custom',
							message: `Function F${input.function} cannot take itself as ${name}`,
							path: [name],
						});
					}
				}
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const x = input.function as number;
			const gates = input.gate_a === undefined ? [] : [`${GVALUE} ${nr3(input.gate_a)},${nr3(input.gate_b)}`];
			const commands = plan(
				...settings(at(x, [...opening, ...operationRows]), input),
				...gates,
				...settings(at(x, trailer), input),
			);
			return scope.execute(async (session) => {
				gateSources(scope, input.source1, input.source2);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(await readback(session, at(x, applied(all, input)))),
					...(gates.length > 0 ? gvalueOf(await session.query(`${GVALUE}?`)) : {}),
				};
				compare(
					scope,
					[...all, ...gateRows],
					input,
					state,
					'the scope clamps a value to what the operation and its source can take',
				);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'get_fft',
		description:
			'Read the FFT of one math function F1-F4: display mode, source, unit, window, acquisition mode, points, span, center frequency, horizontal and vertical scale, reference level, external load and search settings. The stored settings are returned even while the operation is not FFT.',
		input: z.strictObject({ function: fnIndex }),
		annotations: readOnly,
		handler: ({ function: x }, scope) =>
			scope.execute(async (session) => {
				const state: Values = {
					function: x,
					...(await readback(session, at(x, [trace, operationRow, fftSource]))),
					...(await readback(session, [displayRow])),
					...(await readback(session, at(x, fftHead))),
					...modeOf(await session.query(`${spot(x, MODE)}?`)),
					...(await readback(session, at(x, [...fftTail.slice(0, 3), hscale, ...fftTail.slice(3)]))),
				};
				if (typeof state.operation === 'string' && state.operation !== 'FFT') {
					scope.warn(`Function F${x} runs ${state.operation}, so these are stored FFT settings rather than a live FFT`);
				}
				return state;
			}),
	}),
	tool({
		name: 'configure_fft',
		description:
			'Configure the FFT of one math function F1-F4 and read back the requested settings. Providing a source switches the operation of the function to FFT. Without a source, a function running another operation stores the settings and raises a warning. Scale, reference level, excursion, and threshold use the selected FFT unit. Values adjusted by the scope are returned with a warning.',
		input: z
			.strictObject({
				function: fnIndex,
				...inputs([trace]),
				source: z
					.enum(sources)
					.optional()
					.describe('FFT source. Providing it switches the operation of the function to FFT'),
				...inputs([displayRow]),
				...inputs(fftRows),
				mode: z.enum(fftModes).optional().describe('FFT acquisition: normal, max hold or averaging'),
				average_count: z
					.int()
					.min(4)
					.max(1024)
					.optional()
					.describe('Averaging sweeps, 4 to 1024. Requires mode AVERage'),
			})
			.superRefine((input: Values, ctx) => {
				if (input.average_count !== undefined && input.mode !== 'AVERage') {
					ctx.addIssue({
						code: 'custom',
						message: 'average_count applies to the AVERage mode. Set mode to AVERage in the same request',
						path: ['average_count'],
					});
				}
				if (input.source === `F${input.function}`) {
					ctx.addIssue({
						code: 'custom',
						message: `Function F${input.function} cannot take itself as source`,
						path: ['source'],
					});
				}
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const x = input.function as number;
			const modeLine =
				input.mode !== undefined &&
				`${spot(x, MODE)} ${input.mode}${input.average_count === undefined ? '' : `,${input.average_count}`}`;
			const commands = plan(
				...settings(at(x, [trace]), input),
				input.source !== undefined && `${spot(x, ':FUNCtion<x>:OPERation')} FFT`,
				input.source !== undefined && `${spot(x, ':FUNCtion<x>:SOURce1')} ${input.source}`,
				...settings([displayRow], input),
				...settings(at(x, fftHead), input),
				modeLine,
				...settings(at(x, fftTail), input),
			);
			return scope.execute(async (session) => {
				gateSources(scope, input.source);
				const configures = fftRows.some(({ name }) => input[name] !== undefined) || input.mode !== undefined;
				if (configures && input.source === undefined) await guardOperation(session, scope, x);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(input.source === undefined ? {} : await readback(session, at(x, [operationRow, fftSource]))),
					...(await readback(session, applied([displayRow], input))),
					...(await readback(session, at(x, applied([trace, ...fftRows], input)))),
					...(input.mode === undefined ? {} : modeOf(await session.query(`${spot(x, MODE)}?`))),
				};
				compare(
					scope,
					[displayRow, ...fftRows],
					input,
					state,
					'the legal range follows the FFT unit, the probe and the time base',
				);
				if (input.source !== undefined && state.operation !== 'FFT') {
					scope.warn(`The operation was set to FFT but the scope reports ${JSON.stringify(state.operation)}`);
				}
				if (input.source !== undefined && state.source !== input.source) {
					scope.warn(
						`source was set to ${JSON.stringify(input.source)} but the scope reports ${JSON.stringify(state.source)}`,
					);
				}
				if (input.mode !== undefined && state.mode !== input.mode) {
					scope.warn(
						`mode was set to ${JSON.stringify(input.mode)} but the scope reports ${JSON.stringify(state.mode)}`,
					);
				}
				if (input.average_count !== undefined && state.average_count !== input.average_count) {
					scope.warn(
						`average_count was set to ${input.average_count} but the scope reports ${JSON.stringify(state.average_count)}`,
					);
				}
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'autoset_fft',
		description:
			'Place the FFT of one math function at the best position on screen: SPAN spreads the full span, PEAK centers the highest peak, NORMal centers the fundamental with half the FFT sample rate as span. Returns the resulting span, center, scale and reference level.',
		input: z.strictObject({
			function: fnIndex,
			mode: z.enum(autosets).describe('SPAN for full span, PEAK to center the peak, NORMal to center the fundamental'),
		}),
		annotations: mutating,
		handler: ({ function: x, mode }, scope) => {
			const command = `${spot(x, AUTOSET)} ${mode}`;
			return scope.execute(async (session) => {
				await session.command(command);
				const chosen = fftTail.filter(({ name }) =>
					['span', 'center_frequency', 'vertical_scale', 'reference_level'].includes(name),
				);
				return { commands: [command], state: await readback(session, at(x, chosen)) };
			});
		},
	}),
	tool({
		name: 'reset_fft',
		description:
			'Restart the FFT average counting of one math function. Meaningful in the AVERage acquisition mode, whose accumulated average is discarded and cannot be restored. Another mode raises a warning and the reset is still sent.',
		input: z.strictObject({ function: fnIndex }),
		annotations: destructive,
		handler: ({ function: x }, scope) =>
			scope.execute(async (session) => {
				const state = modeOf(await session.query(`${spot(x, MODE)}?`));
				if (state.mode !== 'AVERage') {
					scope.warn(
						`The FFT of F${x} is in ${JSON.stringify(state.mode)} mode, so there is no average count to restart`,
					);
				}
				const command = spot(x, RESET);
				await session.command(command);
				return { ...state, commands: [command] };
			}),
	}),
	tool({
		name: 'read_fft_peaks',
		description:
			'Read the FFT search table of one math function: peak or marker numbers, frequencies in hertz and amplitudes in the FFT unit. The search tool must be on. A search that is off returns a warning and no table.',
		input: z.strictObject({ function: fnIndex }),
		annotations: readOnly,
		handler: ({ function: x }, scope) =>
			scope.execute(async (session) => {
				const search = asState(await session.query(`${spot(x, SEARCH)}?`), searches);
				if (search !== 'PEAK' && search !== 'MARKer') {
					scope.warn(
						search === 'OFF'
							? `The FFT search of F${x} is off, so there is no result table to read. Enable it with configure_fft`
							: `The scope returned an unknown FFT search state ${JSON.stringify(search)}, so no result table was read`,
					);
					return { search };
				}
				const unit = asState(await session.query(`${spot(x, ':FUNCtion<x>:FFT:UNIT')}?`), fftUnits);
				const raw = await session.query(`${spot(x, RESULT)}?`);
				const segments = stripHeader(raw)
					.split(';')
					.map((segment) => segment.trim())
					.filter((segment) => segment.length > 0);
				const first = segments[0]?.split(',') ?? [];
				const type = parseState(first[0] ?? '', resultTypes) ?? { raw };
				if (typeof type !== 'string') {
					scope.warn(`The FFT search result ${JSON.stringify(stripHeader(raw))} was not recognized`);
					return { search, unit, type, entries: [] };
				}
				const entries = [first.slice(1), ...segments.slice(1).map((segment) => segment.split(','))].map((fields) => {
					const [number, frequency, amplitude] = fields.map((field) => Number(field.trim()));
					return [number, frequency, amplitude].every(Number.isFinite)
						? { number, frequency, amplitude }
						: { raw: fields.join(',') };
				});
				if (entries.some((entry) => 'raw' in entry)) {
					scope.warn('Some FFT search entries were not recognized and are returned as raw text');
				}
				return { search, unit, type, entries };
			}),
	}),
];
