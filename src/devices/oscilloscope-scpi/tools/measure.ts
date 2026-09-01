import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { asQuantity, asState, isOn, parseFields, stripHeader } from '../../../scpi/values.ts';
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
import { type Channel, channels, counted as guarded, reading as read, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const MEASURE = ':MEASure';
const MODE = ':MEASure:MODE';
const SIMPLE_CLEAR = ':MEASure:SIMPle:CLEar';
const SIMPLE_ITEM = ':MEASure:SIMPle:ITEM';
const SIMPLE_SOURCE = ':MEASure:SIMPle:SOURce';
const SIMPLE_VALUE = ':MEASure:SIMPle:VALue';
const ADVANCED_CLEAR = ':MEASure:ADVanced:CLEar';
const LINENUMBER = ':MEASure:ADVanced:LINenumber';
const STATISTICS_RESET = ':MEASure:ADVanced:STATistics:RESet';
const ITEM = ':MEASure:ADVanced:P<n>';
const ITEM_TYPE = ':MEASure:ADVanced:P<n>:TYPE';
const ITEM_SOURCE1 = ':MEASure:ADVanced:P<n>:SOURce1';
const ITEM_SOURCE2 = ':MEASure:ADVanced:P<n>:SOURce2';
const ITEM_VALUE = ':MEASure:ADVanced:P<n>:VALue';
const ITEM_STATISTICS = ':MEASure:ADVanced:P<n>:STATistics';

const ITEMS = 12;
const PICOSECOND = 1e-12;
// The gate positions run [-horizontal_grid/2*timebase, horizontal_grid/2*timebase] (pp. 299-300), which follows a
// time base the guide bounds per model; this keeps a value inside what a gate can mean at all and leaves the rest to
// the scope, which moves what it cannot take to the nearest value it can and comes back as a warning.
const gateSeconds = z.number().min(-1e4).max(1e4);

const numbered = (prefix: string, count: number, from = 1): string[] =>
	Array.from({ length: count }, (_, index) => `${prefix}${index + from}`);

// <r> is {A|B|C|D} everywhere the guide writes it; <x> and <m> are "# math functions" and "# memory waveforms",
// which the guide never puts a number to, so four of each is a sanity cap rather than a documented one.
const zooms = numbered('Z', channels.length);
const maths = numbered('F', 4);
const memories = numbered('M', 4);
const digitals = numbered('D', 16, 0);
const zoomedDigitals = numbered('ZD', 16, 0);
const refs = ['REFA', 'REFB', 'REFC', 'REFD'];

export const sources = [...channels, ...zooms, ...maths, ...memories, ...digitals, ...zoomedDigitals, ...refs] as [
	string,
	...string[],
];
// The threshold source takes no digital line (p. 305).
const thresholdSources = [...channels, ...zooms, ...maths, ...memories, ...refs] as [string, ...string[]];

const sourceValue = z.enum(sources);

// The 33 types every list in the chapter shares, in guide order (pp. 286-288).
const shared = [
	'PKPK',
	'MAX',
	'MIN',
	'AMPL',
	'TOP',
	'BASE',
	'LEVELX',
	'CMEAN',
	'MEAN',
	'STDEV',
	'VSTD',
	'RMS',
	'CRMS',
	'MEDIAN',
	'CMEDIAN',
	'OVSN',
	'FPRE',
	'OVSP',
	'RPRE',
	'PER',
	'FREQ',
	'TMAX',
	'TMIN',
	'PWID',
	'NWID',
	'DUTY',
	'NDUTY',
	'WID',
	'NBWID',
	'DELAY',
	'TIMEL',
	'RISE',
	'FALL',
] as const;
const counted = ['CCJ', 'PAREA', 'NAREA', 'AREA', 'ABSAREA', 'CYCLES', 'REDGES', 'FEDGES', 'EDGES'] as const;
const pulses = ['PPULSES', 'NPULSES'] as const;
const areas = ['PACArea', 'NACArea', 'ACArea', 'ABSACArea'] as const;
// The two-source types: ten delay measurements plus the four setup-and-hold ones, all of which take a SOURce2.
const delays = ['PHA', 'SKEW', 'FRR', 'FRF', 'FFR', 'FFF', 'LRR', 'LRF', 'LFR', 'LFF'] as const;
const setupHold = ['TSR', 'TSF', 'THR', 'THF'] as const;
export const paired: readonly string[] = [...delays, ...setupHold];

export const advancedTypes = [
	...shared,
	'RISE10T90',
	'FALL90T10',
	...counted,
	...pulses,
	...delays,
	...areas,
	'PSLOPE',
	'NSLOPE',
	...setupHold,
] as const;

// The same table minus every two-source type, and with the rise and fall percentages the guide prints differently
// here: pp. 302 and 304 spell them RISE20T80 and FALL80T20 where p. 286 spells them RISE10T90 and FALL90T10, and the
// Description of Parameters table (p. 287) defines only the 10-90% pair. Each command is transcribed as printed.
const simpleTypes = [...shared, 'RISE20T80', 'FALL80T20', ...counted, ...pulses, ...areas] as const;

const statisticTypes = ['ALL', 'CURRent', 'MEAN', 'MAXimum', 'MINimum', 'STDev', 'COUNt'] as const;
// The order p. 285 lists the statistics in, which is the only clue to what ALL answers in.
const statisticNames = ['current', 'mean', 'max', 'min', 'stdev', 'count'] as const;

const modes = ['SIMPle', 'ADVanced'] as const;
const styles = ['M1', 'M2'] as const;
const strategies = ['AUTO', 'MANual'] as const;
const bases = ['HISTogram', 'MIN'] as const;
const tops = ['HISTogram', 'MAX'] as const;
const thresholdTypes = ['PERCent', 'ABSolute'] as const;

const readable = z.enum([...simpleTypes, 'ALL']);
const itemIndex = z.number().int().min(1).max(ITEMS);

const analog = /^[CZ](\d)$/;
const digital = /^Z?D\d+$/;

// C<n> and Z<n> are gated by the model's channel count; nothing here can tell whether a math function, a memory, a
// reference or the MSO option carries a waveform, so those are sent as asked and say so.
function gateSource(scope: ScpiScope, source: string): void {
	const channel = analog.exec(source)?.[1];
	if (channel) scope.requireChannel(`C${channel}` as Channel);
	else if (digital.test(source)) {
		scope.warn(`${source} is a digital source and requires the MSO option. Option availability is not known`);
	} else scope.warn(`Whether ${source} carries a waveform is not known. The source is used as requested`);
	if (source.startsWith('Z')) scope.warn(`${source} is a zoomed source and requires zoom to be enabled`);
}

const gateSources = (scope: ScpiScope, ...named: Array<unknown>): void => {
	for (const source of named) if (typeof source === 'string') gateSource(scope, source);
};

const PLACEHOLDER = 'a measurement that is not installed, or has no signal, answers a placeholder instead of a value';

const reading = (scope: ScpiScope, what: string, raw: string) => read(scope, what, raw, PLACEHOLDER);

// <high>,<mid>,<low> on one line, in both directions (pp. 307-308).
const triple = (
	name: string,
	mnemonic: string,
	value: z.ZodType,
	what: string,
	parse: (field: string) => unknown,
	render: (level: number) => string,
): Param => ({
	...param(name, mnemonic, z.object({ high: value, mid: value, low: value }), what, (raw) => {
		const [high = '', mid = '', low = ''] = parseFields(raw);
		return { high: parse(high), mid: parse(mid), low: parse(low) };
	}),
	wire: (level) => levels(level).map(render).join(','),
});

const levels = (level: unknown): number[] => {
	const { high, mid, low } = level as { high: number; mid: number; low: number };
	return [high, mid, low];
};

const ordered = (level: unknown): boolean => {
	const [high, mid, low] = levels(level) as [number, number, number];
	return high >= mid && mid >= low;
};

const setup: Param[] = [
	flag('measurement', MEASURE, 'the measurement function itself', isOn),
	param(
		'mode',
		MODE,
		z.enum(modes),
		'Simple shows measurements. Advanced adds statistics, display styles, histograms and trending',
		(raw) => asState(raw, modes),
	),
	param('simple_source', SIMPLE_SOURCE, sourceValue, 'the trace every simple measurement item is taken from', (raw) =>
		asState(raw, sources),
	),
	param(
		'advanced_items',
		LINENUMBER,
		itemIndex,
		'how many of the twelve advanced measurement items are displayed, 1 to 12',
		guarded('advanced_items'),
	),
	param(
		'advanced_style',
		':MEASure:ADVanced:STYLe',
		z.enum(styles),
		'M1 lists a measurement, statistics and histogram vertically. M2 lists a measurement and statistics horizontally without a histogram',
		(raw) => asState(raw, styles),
	),
	param(
		'amplitude_strategy',
		':MEASure:ASTRategy',
		z.enum(strategies),
		'How top and base are found. Auto derives them from the signal. Manual uses amplitude_top and amplitude_base',
		(raw) => asState(raw, strategies),
	),
	param(
		'amplitude_top',
		':MEASure:ASTRategy:TOP',
		z.enum(tops),
		'Histogram uses the most probable value as the top. Max uses the largest waveform value.',
		(raw) => asState(raw, tops),
	),
	param(
		'amplitude_base',
		':MEASure:ASTRategy:BASE',
		z.enum(bases),
		'Histogram uses the most probable value as the base. Min uses the smallest waveform value.',
		(raw) => asState(raw, bases),
	),
	param(
		'threshold_source',
		':MEASure:THReshold:SOURce',
		z.enum(thresholdSources),
		'Trace whose reference levels are used. Digital sources are not supported',
		(raw) => asState(raw, thresholdSources),
	),
	param(
		'threshold_type',
		':MEASure:THReshold:TYPE',
		z.enum(thresholdTypes),
		'Percent uses threshold_percent. Absolute uses threshold_absolute.',
		(raw) => asState(raw, thresholdTypes),
	),
	triple(
		'threshold_absolute',
		':MEASure:THReshold:ABSolute',
		z.number().min(-1e6).max(1e6),
		'Upper, middle and lower reference levels in volts. Used when threshold_type is Absolute',
		asQuantity,
		nr3,
	),
	triple(
		'threshold_percent',
		':MEASure:THReshold:PERCent',
		z.number().int().min(0).max(100),
		'Upper, middle and lower reference levels as percentages of amplitude. Used when threshold_type is Percent',
		Number,
		String,
	),
];

const composite = new Set(['threshold_absolute', 'threshold_percent']);
const comparable = setup.filter(({ name }) => !composite.has(name));

const position = (name: string, mnemonic: string, what: string): Param => ({
	...clamped(name, mnemonic, gateSeconds, what, asQuantity, PICOSECOND),
	wire: nr3,
});

const gate: Param[] = [
	flag('enabled', ':MEASure:GATE', 'the measurement gate: only what lies between gate A and gate B is measured', isOn),
	position('gate_a', ':MEASure:GATE:GA', 'left gate position in seconds from the trigger'),
	position('gate_b', ':MEASure:GATE:GB', 'right gate position in seconds, never before gate A'),
];

const statistics: Param[] = [
	flag('statistics', ':MEASure:ADVanced:STATistics', 'the statistics of the advanced measurements', isOn),
	flag('histogram', ':MEASure:ADVanced:STATistics:HISTOGram', 'the histogram, which the M1 style shows', isOn),
	param(
		'max_count',
		':MEASure:ADVanced:STATistics:MAXCount',
		z.number().int().min(0).max(1024),
		'Number of measurements included in statistics, 0 to 1024. Zero means unlimited',
		guarded('max_count'),
	),
	param(
		'aim_limit',
		':MEASure:ADVanced:STATistics:AIMLimit',
		z.number().int().min(0).max(1_000_000),
		'Statistics AIM limit',
		guarded('aim_limit'),
	),
];

const itemState = flag('enabled', ITEM, 'the measurement item itself, at its place on the display', isOn);

const itemRows: Param[] = [
	param('type', ITEM_TYPE, z.enum(advancedTypes), 'what the item measures', (raw) => asState(raw, advancedTypes)),
	param('source1', ITEM_SOURCE1, sourceValue, 'the trace the item is taken from', (raw) => asState(raw, sources)),
	param('source2', ITEM_SOURCE2, sourceValue, 'Second trace for a two-source measurement type', (raw) =>
		asState(raw, sources),
	),
];

const at = (index: number, mnemonic: string): string => mnemonic.replace('<n>', String(index));
const atRows = (index: number, rows: readonly Param[]): Param[] =>
	rows.map((row) => ({ ...row, mnemonic: at(index, row.mnemonic) }));

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

async function displayed(session: ScpiSession, scope: ScpiScope): Promise<number> {
	const raw = await session.query(`${LINENUMBER}?`);
	const count = Number(stripHeader(raw));
	if (Number.isInteger(count) && count >= 1 && count <= ITEMS) return count;
	scope.warn(
		`The scope returned ${JSON.stringify(stripHeader(raw))} instead of an item count from 1 to ${ITEMS}. Every item was read`,
	);
	return ITEMS;
}

async function readStatistic(session: ScpiSession, scope: ScpiScope, index: number, type: string) {
	const raw = await session.query(`${at(index, ITEM_STATISTICS)}? ${type}`);
	if (type !== 'ALL') return { [type]: reading(scope, `statistic ${type} of P${index}`, raw), raw };
	const fields = parseFields(raw);
	if (fields.length !== statisticNames.length) return { values: fields.map((field) => asQuantity(field)), raw };
	scope.warn(
		'All statistics are interpreted as current, mean, maximum, minimum, standard deviation and count. This order is not verified on hardware',
	);
	return { ...Object.fromEntries(statisticNames.map((name, i) => [name, asQuantity(fields[i] ?? '')])), raw };
}

async function readItem(session: ScpiSession, scope: ScpiScope, index: number, statistic?: string) {
	const enabled = isOn(await session.query(`${at(index, ITEM)}?`));
	if (!enabled) return { item: index, enabled };
	const type = asState(await session.query(`${at(index, ITEM_TYPE)}?`), advancedTypes);
	const state: Record<string, unknown> = {
		item: index,
		enabled,
		type,
		source1: asState(await session.query(`${at(index, ITEM_SOURCE1)}?`), sources),
	};
	if (typeof type === 'string' && paired.includes(type)) {
		state.source2 = asState(await session.query(`${at(index, ITEM_SOURCE2)}?`), sources);
	}
	state.value = reading(scope, `item P${index}`, await session.query(`${at(index, ITEM_VALUE)}?`));
	if (statistic) state.statistics = await readStatistic(session, scope, index, statistic);
	return state;
}

async function readValues(session: ScpiSession, scope: ScpiScope, names: readonly string[]) {
	const values = [];
	for (const name of names) {
		const raw = await session.query(`${SIMPLE_VALUE}? ${name}`);
		if (name === 'ALL') {
			scope.warn(
				'All installed simple measurements are returned as an ordered list with raw text. The value order is not known',
			);
			values.push({ parameter: name, values: parseFields(raw).map((field) => asQuantity(field)), raw });
		} else values.push({ parameter: name, value: reading(scope, name, raw) });
	}
	return values;
}

// Both install writes are accepted, but :MEASure:SIMPle:VALue? for either spelling never answers on hardware
// (SDS1204X HD firmware 6.9.13.1.1.6.7, reproduced twice), so the value query must never go out.
const unanswerable = ['RISE20T80', 'FALL80T20'];

function refuseUnanswerable(named: readonly string[]): void {
	const hanging = named.filter((name) => unanswerable.includes(name));
	if (hanging.length > 0) {
		throw new UnsupportedError(
			`${hanging.join(' and ')} cannot be read: the simple value query for these spellings never answers on hardware. Use configure_advanced_measurement with type RISE10T90 or FALL90T10, which measures the same transition time`,
		);
	}
}

const chosen = (input: Values): string[] => {
	const many = input.parameters as string[] | undefined;
	const one = input.parameter as string | undefined;
	const named = many ?? (one ? [one] : []);
	if (named.length === 0) throw new ScpiError('Choose what to measure with parameter or parameters');
	return named;
};

const sourceOf = (input: Values): string => {
	const named = (input.source ?? input.channel) as string | undefined;
	if (!named) throw new ScpiError('A measurement source is required. Set source or channel');
	return named;
};

const target = {
	source: sourceValue.optional().describe('Trace to measure. channel is accepted as an alias'),
	channel: sourceValue.optional().describe('Alias of source'),
};

const items = {
	parameter: readable.optional().describe('One measurement type'),
	parameters: z.array(readable).min(1).max(readable.options.length).optional().describe('Several measurement types'),
};

const installable = {
	parameter: z.enum(simpleTypes).optional().describe('One measurement type'),
	parameters: z.array(z.enum(simpleTypes)).min(1).max(simpleTypes.length).optional().describe('Several types'),
};

export const measureTools = [
	tool({
		name: 'get_measurement_setup',
		description:
			'Read the measurement mode, simple source, advanced display settings, amplitude strategy and threshold settings. Use get_measurement_gate for the gate, get_measurement_statistics for statistics and list_measurements for advanced items.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute((session) => readback(session, setup)),
	}),
	tool({
		name: 'configure_measurement_setup',
		description:
			'Set the measurement mode, simple source, advanced display settings, amplitude strategy and threshold settings, then read back the requested values. Threshold levels must be ordered from high to middle to low.',
		input: z
			.strictObject(inputs(setup))
			.refine(
				({ threshold_absolute: absolute, threshold_percent: percent }) =>
					[absolute, percent].every((level) => level === undefined || ordered(level)),
				{
					message: 'Threshold levels must be ordered high, mid and low. Adjust the values so high is greatest',
					path: ['threshold_percent'],
				},
			),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(setup, input));
			return scope.execute(async (session) => {
				gateSources(scope, input.simple_source, input.threshold_source);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(setup, input));
				compare(scope, comparable, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'get_measurement_gate',
		description: 'Read whether the measurement gate is enabled and both gate positions in seconds from the trigger.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute((session) => readback(session, gate)),
	}),
	tool({
		name: 'configure_measurement_gate',
		description:
			'Turn the measurement gate on or off and set its two positions, then read back the requested values. Only the waveform between gate A and gate B is measured. Positions are in seconds from the trigger and may be adjusted to fit the timebase.',
		input: z
			.strictObject(inputs(gate))
			.refine(({ gate_a: a, gate_b: b }) => !(typeof a === 'number' && typeof b === 'number') || a <= b, {
				message: 'gate_a must not be after gate_b. Move gate_a earlier or gate_b later',
				path: ['gate_a'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(gate, input));
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(gate, input));
				compare(scope, gate, input, state, 'the gate is clamped to the time base and to the other gate');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'get_measurement_statistics',
		description:
			'Read advanced measurement statistics and their histogram, count limits, sources and current values. Statistics include current, mean, maximum, minimum, standard deviation and count. Select an item from 1 to 12 or read every displayed item. When statistics are off, no item statistics are read and a warning is returned.',
		input: z.strictObject({
			item: itemIndex.optional().describe('Read one advanced item 1-12 instead of every displayed one'),
			statistic: z.enum(statisticTypes).default('ALL').describe('Statistic to read, or All for the complete set'),
		}),
		annotations: readOnly,
		handler: ({ item, statistic }, scope) =>
			scope.execute(async (session) => {
				const state = await readback(session, statistics);
				if (state.statistics !== true) {
					scope.warn(
						'Measurement statistics are off, so no item statistics were read. Enable them with configure_measurement_statistics',
					);
					return state;
				}
				const slots = item ? [item] : range(await displayed(session, scope));
				const measured = [];
				for (const index of slots) measured.push(await readItem(session, scope, index, statistic));
				return { ...state, items: measured };
			}),
	}),
	tool({
		name: 'configure_measurement_statistics',
		description:
			'Turn advanced measurement statistics on or off, configure the histogram and count limits, and optionally restart accumulation. A maximum count of zero is unlimited. Reset has no query form. Statistics require Advanced measurement mode.',
		input: z.strictObject({
			...inputs(statistics),
			reset: z
				.literal(true)
				.optional()
				.describe('Discard accumulated statistics and start over. The command has no query form'),
		}),
		annotations: destructive,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(statistics, input), input.reset === true && STATISTICS_RESET);
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(statistics, input));
				compare(scope, statistics, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'measure',
		description:
			'Install one or more simple measurements on a trace and read their values. This enables measurements, selects Simple mode and changes the scope display. Use configure_advanced_measurement or measure_delay for two-source measurements. Values the scope cannot measure are preserved as raw text with a warning. RISE20T80 and FALL80T20 are refused because their value query never answers on hardware. Use configure_advanced_measurement with RISE10T90 or FALL90T10 for the same transition time.',
		input: z
			.strictObject({ ...target, ...installable })
			.refine((input) => (input.source ?? input.channel) !== undefined, {
				message: 'source (or channel) is required',
				path: ['source'],
			})
			.refine((input) => (input.parameter ?? input.parameters) !== undefined, {
				message: 'pass parameter, or parameters as a list',
				path: ['parameter'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const source = sourceOf(input);
			const named = chosen(input);
			refuseUnanswerable(named);
			const commands = plan(
				`${MEASURE} ON`,
				`${MODE} SIMPle`,
				`${SIMPLE_SOURCE} ${source}`,
				...named.map((name) => `${SIMPLE_ITEM} ${name},ON`),
			);
			return scope.execute(async (session) => {
				gateSource(scope, source);
				for (const command of commands) await session.command(command);
				return { commands, source, values: await readValues(session, scope, named) };
			});
		},
	}),
	tool({
		name: 'read_measurement',
		description:
			'Read simple measurement values without installing them. A measurement that is not installed may return raw placeholder text with a warning. All returns installed simple measurements as a list whose order is not known. Use measure to install measurements first. RISE20T80 and FALL80T20 are refused because their value query never answers on hardware. Use configure_advanced_measurement with RISE10T90 or FALL90T10 for the same transition time.',
		input: z.strictObject(items),
		annotations: readOnly,
		handler: (input: Values, scope) => {
			const named = input.parameter === undefined && input.parameters === undefined ? ['ALL'] : chosen(input);
			refuseUnanswerable(named);
			return scope.execute(async (session) => {
				const source = asState(await session.query(`${SIMPLE_SOURCE}?`), sources);
				return { source, values: await readValues(session, scope, named) };
			});
		},
	}),
	tool({
		name: 'list_measurements',
		description:
			'List advanced measurement items P1-P12 with their enabled state, type, sources and current value. Select one item or read every displayed item. Use get_measurement_statistics for accumulated statistics.',
		input: z.strictObject({
			item: itemIndex.optional().describe('Read one advanced item 1-12 instead of every displayed one'),
		}),
		annotations: readOnly,
		handler: ({ item }, scope) =>
			scope.execute(async (session) => {
				const slots = item ? [item] : range(await displayed(session, scope));
				const measured = [];
				for (const index of slots) measured.push(await readItem(session, scope, index));
				return { items: measured };
			}),
	}),
	tool({
		name: 'configure_advanced_measurement',
		description:
			'Place an advanced measurement in display slot 1-12 and read it back. This enables measurements and selects Advanced mode. source2 applies only to two-source measurement types, which require analog channels C1-C4. Support for other sources cannot be determined before use.',
		input: z
			.strictObject({
				item: itemIndex.describe('Display slot 1-12 for the measurement'),
				...inputs([itemState, ...itemRows]),
			})
			.superRefine((input: Values, ctx) => {
				const two = typeof input.type === 'string' && paired.includes(input.type);
				if (input.source2 !== undefined && !two) {
					ctx.addIssue({
						code: 'custom',
						message: 'source2 requires a two-source measurement type. Remove it or choose a compatible type',
						path: ['source2'],
					});
				}
				for (const name of ['source1', 'source2']) {
					const value = input[name];
					if (two && value !== undefined && !(channels as readonly unknown[]).includes(value)) {
						const message = 'A two-source measurement requires analog channels C1-C4. Choose an analog source';
						ctx.addIssue({ code: 'custom', message, path: [name] });
					}
				}
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const index = input.item as number;
			const rows = atRows(index, itemRows);
			const commands = plan(
				`${MEASURE} ON`,
				`${MODE} ADVanced`,
				input.enabled === true && `${at(index, ITEM)} ON`,
				...settings(rows, input),
				input.enabled === false && `${at(index, ITEM)} OFF`,
			);
			return scope.execute(async (session) => {
				gateSources(scope, input.source1, input.source2);
				for (const command of commands) await session.command(command);
				const state = { item: index, ...(await readback(session, atRows(index, applied(itemRows, input)))) };
				compare(scope, rows, input, state);
				return {
					commands,
					state,
					value: reading(scope, `item P${index}`, await session.query(`${at(index, ITEM_VALUE)}?`)),
				};
			});
		},
	}),
	tool({
		name: 'measure_delay',
		description:
			'Install a delay measurement between two analog channels C1-C4 in advanced slot 1-12 and read its value. Phase is returned in degrees. Other delay types are returned as time values.',
		input: z.strictObject({
			source_a: z.enum(channels).describe('First source of the pair'),
			source_b: z.enum(channels).describe('Second source of the pair'),
			type: z.enum(delays).describe('Delay type. Phase returns a difference in degrees'),
			item: itemIndex.default(1).describe('Display slot 1-12 for the measurement'),
		}),
		annotations: mutating,
		handler: ({ source_a, source_b, type, item: index }, scope) => {
			const commands = plan(
				`${MEASURE} ON`,
				`${MODE} ADVanced`,
				`${at(index, ITEM)} ON`,
				`${at(index, ITEM_TYPE)} ${type}`,
				`${at(index, ITEM_SOURCE1)} ${source_a}`,
				`${at(index, ITEM_SOURCE2)} ${source_b}`,
			);
			return scope.execute(async (session) => {
				scope.requireChannel(source_a);
				scope.requireChannel(source_b);
				for (const command of commands) await session.command(command);
				const raw = await session.query(`${at(index, ITEM_VALUE)}?`);
				return { commands, item: index, sources: `${source_a}-${source_b}`, type, value: reading(scope, type, raw) };
			});
		},
	}),
	tool({
		name: 'clear_measurements',
		description:
			'Remove installed simple measurements, advanced measurements or both. This cannot be undone and has no query form. The measurement function remains enabled.',
		input: z.strictObject({
			items: z
				.enum(['simple', 'advanced', 'all'])
				.default('all')
				.describe('Set of measurement items to clear. All clears both sets'),
		}),
		annotations: destructive,
		handler: ({ items: which }, scope) => {
			const commands = plan(which !== 'advanced' && SIMPLE_CLEAR, which !== 'simple' && ADVANCED_CLEAR);
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				return { commands };
			});
		},
	}),
];
