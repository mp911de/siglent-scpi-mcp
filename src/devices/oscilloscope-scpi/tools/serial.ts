// The vocabulary the trigger, the decoder and the search share. The subsystems address the same physical settings
// under the same public names, so one row is written once and invoked with the mnemonic of whichever subsystem asks
// for it; a value set or a noun that genuinely differs between them is passed in rather than re-typed.
import * as z from 'zod';
import { nr3 } from '../../../scpi/commands.ts';
import { asQuantity, asState, parseFields } from '../../../scpi/values.ts';
import { clamped, type Param, param, type Values } from '../../../tools/params.ts';
import { type Channel, channels, counted as guarded, type ScpiScope } from '../scope.ts';

export const VOLT = 1e-6;
export const PICOSECOND = 1e-12;

export const digitals = [
	'D0',
	'D1',
	'D2',
	'D3',
	'D4',
	'D5',
	'D6',
	'D7',
	'D8',
	'D9',
	'D10',
	'D11',
	'D12',
	'D13',
	'D14',
	'D15',
] as const;
export const mixed = [...channels, ...digitals] as const;
export const optionalLine = [...mixed, 'DIS'] as const;

export const highLow = ['LOW', 'HIGH'] as const;
export const directed = ['RISing', 'FALLing'] as const;
export const alternating = ['RISing', 'FALLing', 'ALTernate'] as const;
export const polarities = ['POSitive', 'NEGative'] as const;
export const limits = ['LESSthan', 'GREATerthan', 'INNer', 'OUTer'] as const;
export const parities = ['NONE', 'ODD', 'EVEN', 'MARK', 'SPACe'] as const;
export const chipSelects = ['NCS', 'CS'] as const;
// The trigger sections spell the least significant bit LSM (pp. 598, 617, 676), the decode sections LSB (pp. 107,
// 123, 154); each subsystem takes the spelling its own pages print.
export const triggerOrders = ['LSM', 'MSB'] as const;
export const decodeOrders = ['LSB', 'MSB'] as const;
// The same divergence in the audio variant: the trigger section prints IIS (p. 664), the decode section I2S (p. 151).
export const triggerVariants = ['IIS', 'LJ', 'RJ'] as const;
export const decodeVariants = ['I2S', 'LJ', 'RJ'] as const;

export const levelVolts = z.number().min(-1e6).max(1e6);
// The widest time bound any model the guide prints for these limits documents (trigger pp. 424, 444, 506, search
// pp. 363, 371, 378, 386); the scope moves what it cannot take and that comes back as a read-back warning.
export const limitSeconds = z.number().min(1e-9).max(20);
export const timeoutSeconds = z.number().min(1e-7).max(5e-3);
export const stopBits = z.literal([1, 1.5, 2]);
export const rate = (min: number, max: number) => z.number().int().min(min).max(max);

export const uartRates = [
	'600bps',
	'1200bps',
	'2400bps',
	'4800bps',
	'9600bps',
	'19200bps',
	'38400bps',
	'57600bps',
	'115200bps',
] as const;
export const linRates = ['600bps', '1200bps', '2400bps', '4800bps', '9600bps', '19200bps'] as const;
export const canRates = [
	'5kbps',
	'10kbps',
	'20kbps',
	'50kbps',
	'100kbps',
	'125kbps',
	'250kbps',
	'500kbps',
	'800kbps',
	'1Mbps',
] as const;
export const flexRates = ['2500kbps', '5Mbps', '10Mbps'] as const;
export const canfdRates = ['10kbps', '25kbps', '50kbps', '100kbps', '250kbps', '1Mbps'] as const;
export const canfdDataRates = ['500kbps', '1Mbps', '2Mbps', '5Mbps', '8Mbps', '10Mbps'] as const;

// A parameter is one builder shared by every subsystem that has it, invoked with that subsystem's own command: the
// schema instance is shared too, which is what lets the public input field carry the union of what they take.
export const choice =
	(name: string, values: readonly [string, ...string[]], what: string) =>
	(mnemonic: string): Param =>
		param(name, mnemonic, z.enum(values), what, (raw) => asState(raw, values));

export const measured =
	(name: string, schema: z.ZodType, what: string, floor: number) =>
	(mnemonic: string): Param => ({ ...clamped(name, mnemonic, schema, what, asQuantity, floor), wire: nr3 });

export const counted =
	(name: string, schema: z.ZodType, what: string) =>
	(mnemonic: string): Param =>
		param(name, mnemonic, schema, what, guarded(name));

// A preset the guide names, or the <keyword>,<value> it writes any other value as; one query answers both forms.
export const preset =
	(
		name: string,
		presets: readonly [string, ...string[]],
		custom: z.ZodType,
		what: string,
		keyword = 'CUSTom',
		encode: (value: number) => string = String,
	) =>
	(mnemonic: string): Param => ({
		...param(name, mnemonic, z.union([z.enum(presets), custom]), what, (raw) => {
			const [chosen = '', value] = parseFields(raw);
			return value === undefined ? asState(chosen, presets) : guarded(name)(value);
		}),
		wire: (value) => (typeof value === 'number' ? `${keyword},${encode(value)}` : String(value)),
		floor: PICOSECOND,
	});

const LINES = 'an analog channel C1-C4 or a digital channel D0-D15';
const NONE = ', or DIS for no source';

export const lineSource = (name: string, line: string, values: readonly string[] = mixed) =>
	choice(
		name,
		values as unknown as [string, ...string[]],
		`${line} line: ${LINES}${values.includes('DIS') ? NONE : ''}`,
	);

export const lineThreshold = (name: string, line: string) =>
	measured(name, levelVolts, `threshold of the ${line} line in volts`, VOLT);

export const clockSource = choice(
	'clock_source',
	mixed,
	'Clock line. Use an analog channel C1-C4 or digital channel D0-D15',
);
export const clockThreshold = measured('clock_threshold', levelVolts, 'threshold of the clock source in volts', VOLT);
export const dataSource = choice(
	'data_source',
	mixed,
	'Data line. Use an analog channel C1-C4 or digital channel D0-D15',
);
export const dataThreshold = measured('data_threshold', levelVolts, 'threshold of the data source in volts', VOLT);

export const csType = preset(
	'cs_type',
	[...chipSelects, 'TIMeout'],
	timeoutSeconds,
	'SPI chip selection. CS uses chip select, NCS uses its inverse and Timeout uses a clock-idle duration',
	'TIMeout',
	nr3,
);
export const latchEdge = choice('latch_edge', directed, 'Rising or falling clock edge used to sample data.');
export const bitOrder = (values: readonly [string, ...string[]]) =>
	choice(
		'bit_order',
		values,
		'Bit order. MSB reads the most significant bit first. LSB reads the least significant bit first.',
	);

export const BAUD =
	'Baud rate preset or custom rate in bits per second. The accepted range depends on the selected protocol';
export const uartBaud = preset('baud', uartRates, rate(300, 20_000_000), BAUD);
export const linBaud = preset('baud', linRates, rate(300, 20_000_000), BAUD);
export const canBaud = preset('baud', canRates, rate(5000, 1_000_000), BAUD);
export const canfdBaud = preset('baud', canfdRates, rate(10_000, 1_000_000), BAUD);
export const flexBaud = preset('baud', flexRates, rate(1_000_000, 20_000_000), BAUD);
export const canfdDataBaud = (what = 'CAN FD data-phase baud rate preset or custom rate in bits per second') =>
	preset('data_baud', canfdDataRates, rate(100_000, 10_000_000), what);
export const parity = choice('parity', parities, 'UART parity: NONE, ODD, EVEN, MARK or SPACe');
export const stopBitCount = counted('stop_bits', stopBits, 'length of the UART stop bit: 1, 1.5 or 2 bit times');
export const idleLevel = choice('idle_level', highLow, 'idle level of the line: LOW or HIGH');
export const audioVariant = (values: readonly [string, ...string[]]) =>
	choice('audio_variant', values, 'IIS audio variant. LJ is left justified and RJ is right justified');
export const leftLevel = choice(
	'left_level',
	highLow,
	'level of the IIS word select line that marks the left channel: LOW or HIGH',
);

// The waveform-event vocabulary of the trigger and the search: the same physical settings under two prefixes, so
// each subsystem passes the noun its own pages print and everything that reaches the wire is written once.
export const level = (what: string) =>
	measured(
		'level',
		levelVolts,
		`${what} level in volts. The source scale and offset determine the available range`,
		VOLT,
	);
export const levelHigh = (what: string) =>
	measured('level_high', levelVolts, `Upper ${what.toLowerCase()} level in volts. Must not be below level_low`, VOLT);
export const levelLow = (what: string) =>
	measured('level_low', levelVolts, `Lower ${what.toLowerCase()} level in volts. Must not be above level_high`, VOLT);
export const limit = choice(
	'limit',
	limits,
	'How measured time is compared. Less Than uses time_upper, Greater Than uses time_lower and Inner or Outer use both',
);
export const timeLower = measured(
	'time_lower',
	limitSeconds,
	'Lower time bound in seconds. Used by Greater Than, Inner and Outer limits',
	PICOSECOND,
);
export const timeUpper = measured(
	'time_upper',
	limitSeconds,
	'Upper time bound in seconds. Used by Less Than, Inner and Outer limits',
	PICOSECOND,
);

const below = (low: unknown, high: unknown): boolean =>
	typeof low !== 'number' || typeof high !== 'number' || low < high;

// The two orderings and the two exclusions the guide states for every subsystem that has a limit range.
export function bounds(input: Values, ctx: z.RefinementCtx): void {
	if (!below(input.level_low, input.level_high)) {
		ctx.addIssue({
			code: 'custom',
			message: 'level_low must be below level_high. Lower level_low or raise level_high',
			path: ['level_low'],
		});
	}
	if (!below(input.time_lower, input.time_upper)) {
		ctx.addIssue({
			code: 'custom',
			message: 'time_lower must be below time_upper. Lower time_lower or raise time_upper',
			path: ['time_lower'],
		});
	}
	if (input.limit === 'LESSthan' && input.time_lower !== undefined) {
		ctx.addIssue({
			code: 'custom',
			message: 'Less Than uses time_upper. Remove time_lower or choose another limit',
			path: ['time_lower'],
		});
	}
	if (input.limit === 'GREATerthan' && input.time_upper !== undefined) {
		ctx.addIssue({
			code: 'custom',
			message: 'Greater Than uses time_lower. Remove time_upper or choose another limit',
			path: ['time_upper'],
		});
	}
}

// A field the selected type does not have, or a value its own row refuses: the public field carries the union of
// every type's, so this is where the pair the scope has no meaning for is refused before anything is sent.
export function selected(
	rows: readonly Param[],
	what: string,
	input: Values,
	ctx: z.RefinementCtx,
	...ignore: string[]
): void {
	const known = new Map(rows.map((row) => [row.name, row]));
	for (const [name, value] of Object.entries(input)) {
		if (value === undefined || ignore.includes(name)) continue;
		const row = known.get(name);
		if (!row) {
			const message = `${name} is not supported by ${what}. Remove it or choose a compatible one`;
			ctx.addIssue({ code: 'custom', message, path: [name] });
		} else if (!row.schema.safeParse(value).success) {
			ctx.addIssue({ code: 'custom', message: `${what} requires ${row.description}`, path: [name] });
		}
	}
}

// Two subsystems can spell one parameter differently, so the public field offers every value any of them takes and
// the chosen one's own row narrows it, before anything is sent.
function widest(schemas: readonly z.ZodType[]): z.ZodType {
	const [only] = schemas;
	if (only && schemas.length === 1) return only;
	if (schemas.every((schema) => schema instanceof z.ZodEnum)) {
		const values = schemas.flatMap((schema) => (schema as z.ZodEnum).options as string[]);
		return z.enum([...new Set(values)] as [string, ...string[]]);
	}
	return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

export function shape(rows: readonly Param[]): z.ZodRawShape {
	const groups = new Map<string, { first: Param; schemas: Set<z.ZodType> }>();
	for (const row of rows) {
		const group = groups.get(row.name) ?? { first: row, schemas: new Set() };
		group.schemas.add(row.schema);
		groups.set(row.name, group);
	}
	return Object.fromEntries(
		[...groups].map(([name, { first, schemas }]) => [
			name,
			widest([...schemas])
				.optional()
				.describe(first.description),
		]),
	);
}

// A bus addresses its lines under names of its own, so every source any field carries is gated, not one named source.
export function gateSources(scope: ScpiScope, input: Record<string, unknown>): void {
	const values = Object.values(input).flatMap((value) =>
		typeof value === 'object' && value !== null ? Object.values(value) : [value],
	);
	for (const value of new Set(values)) {
		if (typeof value !== 'string') continue;
		if ((channels as readonly string[]).includes(value)) scope.requireChannel(value as Channel);
		if ((digitals as readonly string[]).includes(value)) {
			scope.warn(`${value} is a digital channel and requires the MSO option. Option availability is not known`);
		}
	}
}
