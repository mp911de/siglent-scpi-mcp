import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import {
	asQuantity,
	parseFields,
	parseKeyValues,
	parseQuantity,
	parseState,
	stripHeader,
} from '../../../scpi/values.ts';
import {
	clamped,
	compare,
	inputs,
	type Param,
	pairs,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { type Channel, channels, type Scope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { seconds, thresholdVolts } from './schema.ts';

// EX and EX5 are the external input at 1x and 5x; LINE is a TRSE-only source and TRLV2 takes analog channels only.
export const triggerSources = [...channels, 'EX', 'EX5'] as const;
type Source = (typeof triggerSources)[number];

// TRSE reaches the line voltage as well (p. 203), and SERIAL selects the serial trigger of pp. 208-261.
export const selectSources = [...channels, 'LINE', 'EX', 'EX5'] as const;

export const triggerTypes = ['EDGE', 'SLEW', 'GLIT', 'INTV', 'RUNT', 'DROP', 'TV', 'SERIAL'] as const;
type TriggerType = (typeof triggerTypes)[number];

// The types the guide gives a second trigger level (p. 196).
const dualLevel: readonly string[] = ['SLEW', 'RUNT'];

export const sweep = param(
	'trigger_mode',
	'TRMD',
	z.enum(['AUTO', 'NORM', 'SINGLE', 'STOP']),
	'AUTO, NORM, SINGLE or STOP',
	stripHeader,
);

// The scope adjusts a level outside the source range to the closest legal value; the floor is one 8-bit code at the
// finest 500uV/div, so a requested 0 V is not reported as clamped by quantization alone.
const LEVEL_FLOOR = 2e-5;

const height = clamped(
	'window_height',
	'TRWI',
	thresholdVolts.refine(
		(value) => (parseQuantity(value)?.value ?? -1) >= 0,
		'the window height is the distance between two trigger lines and cannot be negative',
	),
	"Height of the relative trigger window, for example '2V'. The range is 0 to 9 divisions of the source while the center level is 0, so the maximum follows the volts/div and the level. An out-of-range value comes back as a warning.",
	asQuantity,
	LEVEL_FLOOR,
);

const globals = [sweep, height];

const params = [
	param(
		'coupling',
		'TRCP',
		z.enum(['AC', 'DC', 'HFREJ', 'LFREJ']),
		'AC blocks the DC component, DC passes both, HFREJ low-passes, LFREJ high-passes the trigger path',
		stripHeader,
	),
	clamped(
		'level',
		'TRLV',
		thresholdVolts,
		"Trigger level, for example '52mV'. The range is -4.5 to 4.5 divisions of the source and -3 to 3 divisions for EX or EX5. On a dual-level type, this is the higher level. The scope adjusts out-of-range values and returns a warning.",
		asQuantity,
		LEVEL_FLOOR,
	),
	clamped(
		'level_low',
		'TRLV2',
		thresholdVolts,
		'lower trigger level of a dual-level trigger type (SLEW, RUNT), analog channels only, -4.5 to 4.5 divisions',
		asQuantity,
		LEVEL_FLOOR,
	),
	param(
		'slope',
		'TRSL',
		z.enum(['POS', 'NEG', 'WINDOW']),
		'Positive means rising. Negative means falling. Window means alternating and is available only for Edge triggers.',
		stripHeader,
	),
];

const analog = (source: Source): source is Channel => source.startsWith('C');

const addressed = (source: Source) => (analog(source) ? params : params.filter(({ name }) => name !== 'level_low'));

// TRSE, TRPA and TRSE? answer one composite line; the mnemonic of each row is the key it carries in that line.
const named = (rows: readonly Param[], values: Record<string, string>): Values =>
	Object.fromEntries(
		rows.filter(({ mnemonic }) => values[mnemonic] !== undefined).map(({ name, mnemonic }) => [name, values[mnemonic]]),
	);

export interface Selected {
	type?: string;
	source?: string;
	raw: string;
}

// TRSE? answers `<type>,SR,<source>,...`; the type decides whether a second level, WINDOW or SET50 apply.
export async function readSelect(session: ScpiSession): Promise<Selected> {
	const raw = await session.query('TRSE?');
	const [type] = parseFields(raw);
	return { type: parseState(type ?? '', triggerTypes), source: parseKeyValues(raw, 1).SR, raw };
}

// The criteria TRSE? carries after the type are named the way the request names them.
const withCriteria = (selected: Selected): Values => ({
	...selected,
	...named(select, parseKeyValues(selected.raw, 1)),
});

async function readPattern(session: ScpiSession) {
	const raw = await session.query('TRPA?');
	return { ...named(pattern, parseKeyValues(raw)), raw };
}

// `only` limits the read-back to what a request set; without it the whole trigger state is read. SET50 writes the
// levels it centers, so it reads them back.
async function readTrigger(session: ScpiSession, source: Source, only?: Values) {
	const rows = addressed(source);
	const wanted = only
		? rows.filter(({ name }) => only[name] !== undefined || (only.center_level === true && name.startsWith('level')))
		: rows;
	return {
		source,
		...(only ? {} : await readback(session, globals)),
		...(only ? {} : { selected: withCriteria(await readSelect(session)), pattern: await readPattern(session) }),
		...(await readback(session, wanted, `${source}:`)),
	};
}

const volts = (value: unknown): number | undefined =>
	typeof value === 'string' ? parseQuantity(value)?.value : undefined;

const below = (low: unknown, high: unknown): boolean => {
	const [lower, upper] = [volts(low), volts(high)];
	return lower === undefined || upper === undefined || lower < upper;
};

const typeDependent = (input: Values) =>
	input.level_low !== undefined || input.slope === 'WINDOW' || input.center_level === true;

const lowOnAnalogSource = (input: Values) => input.level_low === undefined || String(input.source).startsWith('C');
const lowBelowLevel = (input: Values) => below(input.level_low, input.level);
const centersNoLevel = (input: Values) => input.center_level !== true || (input.level ?? input.level_low) === undefined;

function requireCompatible(scope: Scope, input: Values, source: Source, { type, source: active, raw }: Selected): void {
	const dual = type && dualLevel.includes(type);
	if (input.level_low !== undefined && dual === false) {
		throw new Error(
			`level_low requires a dual-level trigger type (${dualLevel.join(', ')}). Select a compatible trigger type first.`,
		);
	}
	if (input.slope === 'WINDOW' && type && type !== 'EDGE') {
		throw new Error(
			`Window slope requires an Edge trigger, but the current trigger type is ${type}. Select Edge first.`,
		);
	}
	if (input.center_level && active && active !== source) {
		throw new Error(
			`center_level applies to the active trigger source ${active}, not ${source}. Select ${source} as the trigger source first.`,
		);
	}
	if (input.center_level && dual) scope.warn(`center_level has no effect while the trigger type is ${type}.`);
	if (!type)
		scope.warn(`The trigger type response ${JSON.stringify(raw)} was not recognized. The request was sent unchecked.`);
}

// The second level has to stay below the first; when this request does not carry both, the scope holds the other one.
async function requireBelowLevel(session: ScpiSession, scope: Scope, source: Source, low: unknown): Promise<void> {
	const raw = await session.query(`${source}:TRLV?`);
	if (parseQuantity(raw) === undefined) {
		scope.warn(`The trigger level response ${JSON.stringify(raw)} was not recognized. level_low was sent unchecked.`);
		return;
	}
	if (!below(low, raw)) {
		throw new Error(
			`level_low ${low} is not below the current trigger level. Provide a higher level in the same request.`,
		);
	}
}

const holdTypes: Partial<Record<TriggerType, readonly string[]>> = {
	EDGE: ['TI', 'OFF'],
	DROP: ['TI'],
	GLIT: ['PS', 'PL', 'P2', 'P1'],
	RUNT: ['PS', 'PL', 'P2', 'P1'],
	SLEW: ['IS', 'IL', 'I2', 'I1'],
	INTV: ['IS', 'IL', 'I2', 'I1'],
};

// P2/P1 and I2/I1 are the two-bound hold types: in range and out of range (p. 202).
const ranged = (hold: string) => /[12]$/.test(hold);

const holdLimits = (type: TriggerType) =>
	type === 'EDGE' ? { min: 8e-8, max: 1.5, range: '80ns to 1.5s' } : { min: 2e-9, max: 4.2, range: '2ns to 4.2s' };

const standards = [
	'NTSC',
	'PAL',
	'720P/50',
	'720P/60',
	'1080P/50',
	'1080P/60',
	'1080I/50',
	'1080I/60',
	'CUST',
] as const;
type Standard = (typeof standards)[number];

// Line limits per field, and the number of fields the standard allows; a custom standard has as many lines as its
// interlace gives it, which the scope alone knows (pp. 204-205).
const video: Record<Standard, { lines: readonly number[]; fields: number }> = {
	NTSC: { lines: [263, 262], fields: 2 },
	PAL: { lines: [313, 312], fields: 2 },
	'720P/50': { lines: [750], fields: 0 },
	'720P/60': { lines: [750], fields: 0 },
	'1080P/50': { lines: [1125], fields: 0 },
	'1080P/60': { lines: [1125], fields: 0 },
	'1080I/50': { lines: [563, 562], fields: 2 },
	'1080I/60': { lines: [563, 562], fields: 2 },
	CUST: { lines: [], fields: 8 },
};

const select: Param[] = [
	param(
		'source',
		'SR',
		z.enum(selectSources),
		'C1-C4 for any trigger type. Line, EX, and EX5 are available only for Edge triggers.',
	),
	param(
		'hold_type',
		'HT',
		z.enum(['TI', 'OFF', 'PS', 'PL', 'P2', 'P1', 'IS', 'IL', 'I2', 'I1']),
		'hold/limit type: TI (time) and OFF for EDGE, TI for DROP, PS/PL/P2/P1 (pulse smaller, larger, in range, out of range) for GLIT and RUNT, IS/IL/I2/I1 (interval smaller, larger, in range, out of range) for SLEW and INTV',
	),
	param(
		'hold_value',
		'HV',
		seconds,
		'Hold or limit time. For ranged types, this is the lower bound. Edge supports 80ns to 1.5s. Other types support 2ns to 4.2s.',
	),
	param('hold_value2', 'HV2', seconds, 'upper bound of the in-range and out-of-range hold types P2, P1, I2 and I1'),
	param('standard', 'STAN', z.enum(standards), 'TV standard'),
	param(
		'sync',
		'SYNC',
		z.enum(['ANY', 'SELECT']),
		'TV synchronization. Any triggers on any line. Select triggers on the requested line. Support is unverified on hardware.',
	),
	param(
		'line',
		'LINE',
		z.number().int().min(1),
		'TV line to trigger on. The maximum depends on the standard and field.',
	),
	param(
		'field',
		'FLD',
		z.number().int().min(1).max(8),
		'TV field. Use 1 or 2 for interlaced standards, or 1 to 8 for Custom.',
	),
];

const holdFields = ['source', 'hold_type', 'hold_value', 'hold_value2'];
const videoFields = ['source', 'standard', 'sync', 'line', 'field'];
const belongs = (type: TriggerType) => (type === 'TV' ? videoFields : type === 'SERIAL' ? [] : holdFields);

function holdProblem(type: TriggerType, input: Values): string | undefined {
	const { hold_type: hold, hold_value: value, hold_value2: upper } = input;
	const allowed = holdTypes[type] ?? [];
	if (hold !== undefined && !allowed.includes(hold as string)) {
		return `${type} supports hold_type ${allowed.join(', ')}. Choose a compatible value.`;
	}
	const { min, max, range } = holdLimits(type);
	for (const time of [value, upper]) {
		const given = time === undefined ? undefined : parseQuantity(time as string)?.value;
		if (given !== undefined && (given < min || given > max)) {
			return `Hold values for ${type} must be within ${range}.`;
		}
	}
	if (hold !== undefined && ranged(hold as string)) {
		if (value === undefined || upper === undefined)
			return `hold_type ${hold} is a range. Provide hold_value and hold_value2.`;
		if (!below(value, upper)) return 'hold_value is the lower bound and must be below hold_value2.';
	} else if (upper !== undefined) {
		return 'hold_value2 requires an in-range or out-of-range hold type.';
	}
	return undefined;
}

function videoProblem({ standard, line, field }: Values): string | undefined {
	if (field !== undefined && line === undefined) return 'field requires line. Provide both values.';
	if (line === undefined) return undefined;
	if (standard === undefined) return 'line and field require a standard. Provide standard in the same request.';
	const { lines, fields } = video[standard as Standard];
	if (field !== undefined && fields === 0) {
		return `${standard} is progressive and does not support a field. Remove field or choose an interlaced standard.`;
	}
	if (field !== undefined && (field as number) > fields)
		return `${standard} has ${fields} fields. Choose a valid field.`;
	const max = lines[field === undefined ? 0 : (field as number) - 1] ?? lines[0];
	if (max !== undefined && (line as number) > max) {
		return `${standard} supports lines 1 to ${max}${fields > 0 ? ` in field ${field ?? 1}` : ''}. Choose a valid line.`;
	}
	return undefined;
}

function selectProblem(input: Values): string | undefined {
	const type = input.type as TriggerType;
	const allowed = belongs(type);
	const extra = select.map(({ name }) => name).filter((name) => input[name] !== undefined && !allowed.includes(name));
	if (extra.length > 0)
		return `${extra.join(', ')} cannot be used with trigger type ${type}. Remove these fields or choose another type.`;
	const { source } = input;
	if (type !== 'EDGE' && source !== undefined && !String(source).startsWith('C')) {
		return `${source} is available only for Edge triggers. Choose channel C1-C4 or select Edge.`;
	}
	return type === 'TV' ? videoProblem(input) : holdProblem(type, input);
}

const statuses = z.enum(['X', 'L', 'H']);
const condition = param(
	'condition',
	'STATE',
	z.enum(['AND', 'OR', 'NAND']),
	'Boolean operator over channel statuses. NOR support is unverified and unavailable through this typed tool.',
);

const pattern: Param[] = [
	...channels.map((source) =>
		param(
			source.toLowerCase(),
			source,
			statuses,
			`${source} in the pattern: X ignores the channel, L is below and H above its trigger level`,
		),
	),
	condition,
];

const statusOf = (values: Values, source: Channel) => values[source.toLowerCase()];
const requested = (values: Values) => channels.filter((source) => statusOf(values, source) !== undefined);
const triggersOn = (values: Values) => channels.some((source) => (statusOf(values, source) ?? 'X') !== 'X');

export const triggerTools = [
	tool({
		name: 'get_trigger',
		description:
			'Read the trigger state for one source, including sweep mode, window height, trigger type and criteria, pattern, coupling, levels, and slope. Lower level is available only for analog channels. Single acquisition reports Stop after triggering.',
		input: z.object({ source: z.enum(triggerSources).describe('Trigger source C1-C4, EX, or EX5.') }),
		annotations: readOnly,
		handler: ({ source }, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				if (analog(source)) scope.requireChannel(source);
				return readTrigger(session, source);
			}),
	}),
	tool({
		name: 'configure_trigger',
		description:
			'Configure coupling, level, lower level, and slope for one trigger source, or center the level on the source waveform. Lower level requires a dual-level trigger and an analog source. Window slope requires an Edge trigger. Centering applies only to the active trigger source and has no effect on dual-level triggers. The scope may adjust levels outside the source range.',
		input: z
			.object({
				source: z.enum(triggerSources).describe('Trigger source C1-C4, EX, or EX5.'),
				...inputs(params),
				center_level: z.boolean().optional().describe('Set the trigger level to the center of the source waveform.'),
			})
			.refine(lowOnAnalogSource, {
				message: 'level_low requires an analog channel source. Choose C1-C4.',
				path: ['level_low'],
			})
			.refine(lowBelowLevel, {
				message: 'level_low is the lower of the two levels and must stay below level',
				path: ['level_low'],
			})
			.refine(centersNoLevel, {
				message: 'center_level replaces the trigger levels. Remove level and level_low from this request.',
				path: ['center_level'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const source = input.source as Source;
			const commands = plan(...settings(params, input, `${source}:`), input.center_level === true && 'SET50');
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (analog(source)) scope.requireChannel(source);
				if (typeDependent(input)) requireCompatible(scope, input, source, await readSelect(session));
				if (input.level_low !== undefined && input.level === undefined) {
					await requireBelowLevel(session, scope, source, input.level_low);
				}
				for (const command of commands) await session.command(command);
				const state = await readTrigger(session, source, input);
				compare(scope, params, input, state, 'a level outside the range of the source is adjusted by the scope');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'configure_trigger_type',
		description:
			'Select the trigger type, source, and criteria. Edge supports hold times from 80ns to 1.5s. Slew, Glitch, Interval, Runt, and Dropout support 2ns to 4.2s. TV supports a standard, synchronization mode, line, and field. Serial requires SDS1000X-E. Only fields for the selected type are accepted. Select Pattern on the scope before using configure_pattern_trigger.',
		input: z
			.object({
				type: z
					.enum(triggerTypes)
					.describe('Trigger type. GLIT means Glitch, INTV means Interval, and DROP means Dropout.'),
				...inputs(select),
			})
			.superRefine((input, ctx) => {
				const problem = selectProblem(input as Values);
				if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['type'] });
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const type = input.type as TriggerType;
			const criteria = pairs(select, input);
			const commands = [`TRSE ${type}${criteria && `,${criteria}`}`];
			return scope.execute(async (session) => {
				if (type === 'SERIAL') scope.require('xe');
				else scope.requireLegacyDialect();
				const source = input.source;
				if (typeof source === 'string' && source.startsWith('C')) scope.requireChannel(source as Channel);
				if (input.standard === 'CUST' && input.line !== undefined) {
					scope.warn('The line count for a Custom TV standard depends on its interlace. line was sent unchecked.');
				}
				for (const command of commands) await session.command(command);
				const state = withCriteria(await readSelect(session));
				compare(scope, select, input, state, 'The trigger selection');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'configure_pattern_trigger',
		description:
			'Set channel statuses and the boolean condition for the pattern trigger. Each channel may be ignored, below its trigger level, or above it. At least one channel must participate and must be enabled. Select Pattern on the scope first. NOR support is unverified and unavailable through this typed tool.',
		input: z
			.object({ ...inputs(pattern), condition: condition.schema.describe(condition.description) })
			.refine((input: Values) => requested(input).length > 0, {
				message: 'Set the status of at least one channel.',
				path: ['c1'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = [`TRPA ${pairs(pattern, input)}`];
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				for (const source of requested(input)) scope.requireChannel(source);
				if (!triggersOn(input)) {
					const current = await readPattern(session);
					if (!triggersOn({ ...current, ...input })) {
						throw new Error('Every channel would be ignored. Include at least one channel in the trigger pattern.');
					}
				}
				for (const command of commands) await session.command(command);
				const state = await readPattern(session);
				compare(scope, pattern, input, state, 'A source status applies only while the channel is enabled.');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'configure_trigger_window',
		description:
			'Set the height between the two lines of the relative trigger window. The range depends on the center level and source volts per division. The scope may adjust the value. The command applies only while the trigger window type is Relative, which cannot be selected or read through this interface.',
		input: z.object({ window_height: height.schema.describe(height.description) }),
		annotations: mutating,
		handler: (input: Values, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const commands = settings([height], input);
				for (const command of commands) await session.command(command);
				const state = await readback(session, [height]);
				compare(scope, [height], input, state, 'The setting applies only while the trigger window type is Relative.');
				return { commands, state };
			}),
	}),
];
