// The serial trigger of pp. 208-261: one protocol descriptor per bus, from which the input schema, the wire commands
// and the read-back are derived. Every protocol shares the same shape, so I2C, SPI, UART, CAN and LIN differ in their
// tables only.
import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseFields, parseQuantity, stripHeader } from '../../../scpi/values.ts';
import {
	applied,
	clamped,
	compare,
	inputs,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import type { Scope } from '../scope.ts';
import {
	type DecodeSource,
	decodeSource,
	requireProtocol,
	threshold,
	thresholdIssue,
	thresholdMatchesSource,
} from './decode.ts';
import { mutating, readOnly, tool } from './define.ts';
import { withUnit } from './schema.ts';
import { readSelect } from './trigger.ts';

// A threshold outside the vertical range of its source is clamped by the scope; the floor is one 8-bit code at the
// finest 500uV/div, so a requested 0 V is not reported as clamped by quantization alone.
const THRESHOLD_FLOOR = 2e-5;

const levelOf = (name: string) => `${name}_threshold`;

// TR<proto>:<MNEM> <source>[,<threshold>] carries two public fields in one positional command (pp. 210-211).
const source = (name: string, mnemonic: string, what: string): Param[] => [
	param(name, mnemonic, decodeSource, `${what} source`),
	clamped(
		levelOf(name),
		mnemonic,
		threshold,
		`${what} threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.`,
		asQuantity,
		THRESHOLD_FLOOR,
	),
];

// The guide ignores a field by writing a sentinel one past its range: 128 or 1024 for an I2C address, 256 for a data
// byte. The public API says `any` and the sentinel never leaves this module.
const ANY = 'any';
const DONT_CARE_BYTE = 256;

const byteValue = z.union([
	z
		.number()
		.int()
		.min(0)
		.max(DONT_CARE_BYTE - 1),
	z.literal(ANY),
]);

const count = (raw: string): unknown => parseQuantity(raw)?.value ?? raw;

interface Protocol {
	prefix: string;
	sources: readonly Param[];
	params: readonly Param[];
	// the field whose value decides which of the others apply: the condition of I2C, the chip-select type of SPI.
	gate?: string;
	// public field -> the gate values the guide lists it for; anything else is refused.
	applies?: Record<string, readonly string[]>;
	// public `any` -> the don't-care value of each field, which some protocols take from another: the I2C address
	// follows the condition, the CAN identifier its ID length.
	sentinel?: (values: Values) => Record<string, number>;
	// range rules the gate decides.
	check?: (input: Values, gate?: string) => string | undefined;
	// the mnemonics in the order the guide documents them, where that is not every source and then every parameter.
	order?: readonly string[];
}

const rowsOf = ({ sources, params }: Protocol) => [...sources, ...params];
const sourceRows = ({ sources }: Protocol) => sources.filter(({ schema }) => schema === decodeSource);
// Every protocol but SPI documents its sources first, so the commands travel in the order they are declared in.
const inGuideOrder = ({ prefix, order }: Protocol, commands: string[]): string[] =>
	order === undefined ? commands : commands.toSorted((a, b) => rank(order, prefix, a) - rank(order, prefix, b));

const rank = (order: readonly string[], prefix: string, command: string): number =>
	order.indexOf(command.slice(prefix.length).split(' ')[0] ?? '');

const wire = (values: Values, { name }: Param) =>
	`${values[name]}${values[levelOf(name)] === undefined ? '' : `,${values[levelOf(name)]}`}`;

const toWire = (values: Values, dontCare: Record<string, number>): Values =>
	Object.fromEntries(
		Object.entries(values).map(([name, value]) => [name, value === ANY ? (dontCare[name] ?? value) : value]),
	);

const fromWire = (values: Values, dontCare: Record<string, number>): Values =>
	Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			name,
			value !== undefined && value === dontCare[name] ? ANY : value,
		]),
	);

const gateOf = (protocol: Protocol) => protocol.gate ?? 'condition';
const gateRow = (protocol: Protocol) => protocol.params.find(({ name }) => name === gateOf(protocol));

const gateValues = (protocol: Protocol): string[] => {
	const row = gateRow(protocol);
	return row?.schema instanceof z.ZodEnum ? (row.schema.options as string[]) : [];
};

function conditionProblem(protocol: Protocol, input: Values, condition?: string): string | undefined {
	const applies = protocol.applies ?? {};
	const misplaced = Object.keys(applies).filter(
		(name) => input[name] !== undefined && condition !== undefined && !applies[name]?.includes(condition),
	);
	if (misplaced.length > 0) {
		const listed = misplaced.map((name) => `${name} for ${applies[name]?.join(', ')}`).join(', ');
		return `${misplaced.join(', ')} cannot be used with ${gateOf(protocol)} ${condition}. Use ${listed}.`;
	}
	return protocol.check?.(input, condition);
}

function protocolInput(protocol: Protocol): z.ZodObject {
	const rows = rowsOf(protocol);
	return sourceRows(protocol)
		.reduce(
			(schema, { name }) =>
				schema
					.refine(
						(input: Values) =>
							thresholdMatchesSource(input[name] as DecodeSource, input[levelOf(name)] as string | undefined),
						thresholdIssue(name),
					)
					.refine((input: Values) => input[name] !== undefined || input[levelOf(name)] === undefined, {
						message: `${levelOf(name)} requires ${name}. Provide both values.`,
						path: [levelOf(name)],
					}),
			z.strictObject(inputs(rows)).refine((input: Values) => rows.some(({ name }) => input[name] !== undefined), {
				message: 'Provide at least one setting to configure.',
			}),
		)
		.superRefine((input: Values, ctx) => {
			const gate = input[gateOf(protocol)];
			const problem = typeof gate === 'string' ? conditionProblem(protocol, input, gate) : undefined;
			if (problem) ctx.addIssue({ code: 'custom', message: problem, path: [gateOf(protocol)] });
		});
}

// The criteria only reach the scope while TRSE selects the serial trigger (p. 208); this one does not select it, so
// that a request never silently retargets the trigger.
async function requireSerial(scope: Scope, session: ScpiSession): Promise<void> {
	const { type, raw } = await readSelect(session);
	if (type === 'SERIAL') return;
	if (type === undefined) {
		scope.warn(`The trigger type response ${JSON.stringify(raw)} was not recognized. The request was sent unchecked.`);
		return;
	}
	throw new Error(
		`Serial trigger criteria require the Serial trigger type, but the current type is ${type}. Select Serial with configure_trigger_type first.`,
	);
}

// A gate-dependent field sent without its gate is checked against the value the scope holds.
async function currentGate(
	session: ScpiSession,
	scope: Scope,
	protocol: Protocol,
	input: Values,
): Promise<string | undefined> {
	const given = input[gateOf(protocol)];
	if (typeof given === 'string') return given;
	const dependent = [...Object.keys(protocol.applies ?? {}), ...Object.keys(protocol.sentinel?.({}) ?? {})];
	if (!dependent.some((name) => input[name] !== undefined)) return undefined;
	const query = `${protocol.prefix}${gateRow(protocol)?.mnemonic}?`;
	const raw = await session.query(query);
	const current = stripHeader(raw).toUpperCase();
	if (gateValues(protocol).includes(current)) return current;
	scope.warn(
		`The ${gateOf(protocol)} response ${JSON.stringify(raw)} was not recognized. The request was sent unchecked.`,
	);
	return undefined;
}

// `only` limits the read-back to what a request set; without it the whole protocol is read. A don't-care value is
// decoded from the gate, which a request that does not name it has already read, so it is passed in.
async function readProtocol(session: ScpiSession, protocol: Protocol, only?: Values, gate?: string): Promise<Values> {
	const state: Values = {};
	const sources = only ? sourceRows(protocol).filter(({ name }) => only[name] !== undefined) : sourceRows(protocol);
	const rows = only ? applied(protocol.params, only) : protocol.params;
	for (const { name, mnemonic } of sources) {
		const [wired, volts] = parseFields(await session.query(`${protocol.prefix}${mnemonic}?`));
		Object.assign(state, { [name]: wired, ...(volts !== undefined && { [levelOf(name)]: asQuantity(volts) }) });
	}
	Object.assign(state, await readback(session, rows, protocol.prefix));
	const writeOnly = rows.filter(({ parse }) => !parse).map(({ mnemonic }) => `${protocol.prefix}${mnemonic}`);
	const dontCare = protocol.sentinel?.({ ...state, ...(gate !== undefined && { [gateOf(protocol)]: gate }) }) ?? {};
	return {
		...fromWire(state, dontCare),
		...(writeOnly.length > 0 && { write_only: writeOnly }),
	};
}

function configureProtocol(scope: Scope, protocol: Protocol, input: Values): Promise<Record<string, unknown>> {
	return scope.execute(async (session) => {
		requireProtocol(scope, ...sourceRows(protocol).map(({ name }) => input[name] as DecodeSource | undefined));
		await requireSerial(scope, session);
		const condition = await currentGate(session, scope, protocol, input);
		const problem = conditionProblem(protocol, input, condition);
		if (problem) throw new Error(problem);
		const dontCare = protocol.sentinel?.({ ...input, [gateOf(protocol)]: condition }) ?? {};
		const unresolved = Object.keys(input).filter((name) => input[name] === ANY && dontCare[name] === undefined);
		if (unresolved.length > 0) {
			throw new Error(
				`${unresolved.join(', ')} cannot use ${ANY} without ${gateOf(protocol)}. Provide it in the same request.`,
			);
		}
		const values = toWire(input, dontCare);
		const commands = plan(
			...inGuideOrder(protocol, [
				...sourceRows(protocol)
					.filter(({ name }) => values[name] !== undefined)
					.map((row) => `${protocol.prefix}${row.mnemonic} ${wire(values, row)}`),
				...settings(protocol.params, values, protocol.prefix),
			]),
		);
		for (const command of commands) await session.command(command);
		const state = await readProtocol(session, protocol, input, condition);
		compare(scope, rowsOf(protocol), input, state, 'the scope keeps the criteria of the protocol it triggers on');
		return { commands, state };
	});
}

function readSerial(scope: Scope, protocol: Protocol, name: string): Promise<Record<string, unknown>> {
	return scope.execute(async (session) => {
		requireProtocol(scope);
		const { type, raw } = await readSelect(session);
		if (type !== undefined && type !== 'SERIAL') {
			scope.warn(`The current trigger type is ${type}. The ${name} criteria are not active.`);
		}
		return { trigger_type: type ?? { raw }, ...(await readProtocol(session, protocol)) };
	});
}

const conditions = ['START', 'STOP', 'RESTART', 'NOACK', 'EEPROM', '7ADDA', '10ADDA', 'DALENTH'] as const;

// 7ADDA and 10ADDA give the address its width, and with it the don't-care value the guide documents (p. 214).
const addressBits: Record<string, number> = { '7ADDA': 7, '10ADDA': 10 };
const bitsOf = (condition: unknown) => (typeof condition === 'string' ? addressBits[condition] : undefined);

const i2cParams: Param[] = [
	param(
		'condition',
		'CON',
		z.enum(conditions),
		'I2C trigger condition. Address and data fields depend on the selected condition.',
		stripHeader,
	),
	param(
		'address',
		'ADDR',
		z.union([
			z
				.number()
				.int()
				.min(0)
				.max(2 ** 10 - 1),
			z.literal(ANY),
		]),
		'address to trigger on, 0 to 127 with condition 7ADDA and 0 to 1023 with 10ADDA, or `any` to ignore it',
		count,
	),
	param('data', 'DATA', byteValue, 'first data byte, 0 to 255, or `any` to ignore it', count),
	param('data2', 'DAT2', byteValue, 'second data byte, 0 to 255, or `any` to ignore it', count),
	param(
		'qualifier',
		'QUAL',
		z.enum(['EQUAL', 'MORE', 'LESS']),
		'how data is compared in an EEPROM frame: equal to, greater than or less than',
		stripHeader,
	),
	param(
		'direction',
		'RW',
		z.enum(['READ', 'WRITE', 'DONT_CARE']),
		'Value of the read/write bit to trigger on. Dont Care triggers on either.',
		stripHeader,
	),
	param('address_length', 'ALEN', z.enum(['7BIT', '10BIT']), 'address width of a DALENTH search', stripHeader),
	param(
		'data_length',
		'DLEN',
		z.number().int().min(1).max(12),
		'data length of a DALENTH search, 1 to 12 bytes',
		count,
	),
];

const i2c: Protocol = {
	prefix: 'TRIIC:',
	sources: [...source('scl', 'SCL', 'serial clock (SCL)'), ...source('sda', 'SDA', 'serial data (SDA)')],
	params: i2cParams,
	applies: {
		address: ['7ADDA', '10ADDA'],
		data: ['7ADDA', '10ADDA', 'EEPROM'],
		data2: ['7ADDA', '10ADDA'],
		qualifier: ['EEPROM'],
		address_length: ['DALENTH'],
		data_length: ['DALENTH'],
	},
	sentinel: ({ condition }) => {
		const bits = bitsOf(condition);
		return { data: DONT_CARE_BYTE, data2: DONT_CARE_BYTE, ...(bits !== undefined && { address: 2 ** bits }) };
	},
	check: (input, condition) => {
		const bits = bitsOf(condition);
		const address = input.address;
		return typeof address === 'number' && bits !== undefined && address >= 2 ** bits
			? `Condition ${condition} supports addresses from 0 to ${2 ** bits - 1}. Use any to ignore the address.`
			: undefined;
	},
};

// TRSPI:CLK:TIM delimits two frames while the chip select is TIMEOUT; p. 226 gives 100ns to 5ms and calls its own
// response a <threshold> by copy-paste, though the value is a time.
const clockTimeout = withUnit(
	['', 'S', 'MS', 'US', 'NS'],
	"Clock timeout with a unit, for example '2us'. A value without a unit means seconds.",
).refine(
	(value) => {
		const seconds = parseQuantity(value)?.value;
		return seconds !== undefined && seconds >= 1e-7 && seconds <= 5e-3;
	},
	{ message: 'Clock timeout must be between 100ns and 5ms.' },
);

// TRSPI:DATA carries one value per bit of TRSPI:DLEN, X for a bit it ignores (p. 233). The public form is a string or
// an array of bits, the wire form the guide's comma-separated list.
const dataPattern = z
	.union([
		z.string().regex(/^[01xX]{4,96}$/, "4 to 96 bits written as 0, 1 and X, e.g. '10X1'"),
		z
			.array(z.enum(['0', '1', 'X']))
			.min(4)
			.max(96),
	])
	.transform((value) => (typeof value === 'string' ? [...value.toUpperCase()] : value).join(','));

const chipSelect = { CS: 'cs', NCS: 'ncs', TIMEOUT: 'clock_timeout' } as const;
type ChipSelect = keyof typeof chipSelect;

// DLEN before DATA: the pattern is only meaningful at the length the scope holds, so the length goes first even though
// the guide documents DATA on the earlier page.
const spiParams: Param[] = [
	param('edge', 'CLK:EDGE', z.enum(['RISING', 'FALLING']), 'clock edge the data is latched on', stripHeader),
	param('clock_timeout', 'CLK:TIM', clockTimeout, 'clock timeout of the TIMEOUT chip select, 100ns to 5ms', asQuantity),
	param(
		'chip_select_type',
		'CSTP',
		z.enum(['CS', 'NCS', 'TIMEOUT']),
		'what delimits a frame: an active-high CS, an active-low ~CS, or a clock timeout',
		stripHeader,
	),
	param('trigger_source', 'TRTY', z.enum(['MOSI', 'MISO']), 'line the data pattern is matched on', stripHeader),
	param('data_length', 'DLEN', z.number().int().min(4).max(96), 'length of the data pattern in bits, 4 to 96', count),
	param(
		'data',
		'DATA',
		dataPattern,
		'Data pattern with exactly data_length bits. Use a string such as "10X1" or an array such as ["1","0","X","1"]. X ignores a bit. The data pattern has no query form.',
	),
	param(
		'bit_order',
		'BIT',
		z.enum(['MSB', 'LSB']),
		'bit the pattern starts at, most or least significant',
		stripHeader,
	),
];

const spi: Protocol = {
	prefix: 'TRSPI:',
	sources: [
		...source('clk', 'CLK', 'serial clock (CLK)'),
		...source('mosi', 'MOSI', 'master-out slave-in (MOSI)'),
		...source('miso', 'MISO', 'master-in slave-out (MISO)'),
		...source('cs', 'CS', 'active-high chip-select (CS)'),
		...source('ncs', 'NCS', 'active-low chip-select (~CS)'),
	],
	params: spiParams,
	gate: 'chip_select_type',
	applies: { cs: ['CS'], ncs: ['NCS'], clock_timeout: ['TIMEOUT'] },
	check: (input, type) =>
		type === undefined || input.chip_select_type === undefined || input[chipSelect[type as ChipSelect]] !== undefined
			? undefined
			: `chip_select_type ${type} requires ${chipSelect[type as ChipSelect]}. Provide it in the same request.`,
	// SPI is the one protocol whose sources do not all come first: CSTP (p. 229) decides which chip-select source means
	// anything, so it reaches the scope before CS (p. 230) and NCS (p. 231). DLEN and DATA travel the other way round.
	order: ['CLK', 'CLK:EDGE', 'CLK:TIM', 'MOSI', 'MISO', 'CSTP', 'CS', 'NCS', 'TRTY', 'DLEN', 'DATA', 'BIT'],
};

const spiInput = protocolInput(spi).refine(
	({ data, data_length }: Values) => data === undefined || (data as string).split(',').length === data_length,
	{
		message: 'data requires exactly data_length values. Provide data_length in the same request.',
		path: ['data'],
	},
);

// TR<proto>:BAUD <value1>[,<value2>] takes one of a few standard rates on its own and any other rate as CUSTOM,<rate>
// (pp. 242, 261). The public field is the rate itself either way.
const baudRate = (raw: string): unknown => count(parseFields(raw).at(-1) ?? raw);

const baudRow = (standard: number[], min: number, max: number): Param => ({
	...param(
		'baud',
		'BAUD',
		z.number().int().min(min).max(max),
		`Baud rate in bits per second from ${min} to ${max}. Standard rates are ${standard.join(', ')}.`,
		baudRate,
	),
	wire: (value) => (standard.includes(value as number) ? String(value) : `CUSTOM,${value}`),
});

const uartParams: Param[] = [
	param('trigger_source', 'TRTY', z.enum(['RX', 'TX']), 'line the trigger condition is matched on', stripHeader),
	param(
		'condition',
		'CON',
		z.enum(['START', 'STOP', 'DATA', 'ERROR']),
		'START, STOP, DATA (a search on a data byte) or ERROR',
		stripHeader,
	),
	param(
		'qualifier',
		'QUAL',
		z.enum(['EQUAL', 'MORE', 'LESS']),
		'how the data byte is compared: equal to, greater than or less than',
		stripHeader,
	),
	param('data', 'DATA', byteValue, 'data byte to trigger on, 0 to 255, or `any` to ignore it', count),
	baudRow([600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200], 300, 5_000_000),
	param('data_length', 'DLEN', z.number().int().min(5).max(8), 'data length in bits, 5 to 8', count),
	param('parity', 'PAR', z.enum(['NONE', 'ODD', 'EVEN']), 'parity check of a frame', stripHeader),
	param('polarity', 'POL', z.enum(['LOW', 'HIGH']), 'idle level of the line', stripHeader),
	param('stop_bits', 'STOP', z.literal([1, 1.5, 2]), 'length of the stop bit in bit times', count),
	param('bit_order', 'BIT', z.enum(['LSB', 'MSB']), 'bit a frame starts at, least or most significant', stripHeader),
];

const uart: Protocol = {
	prefix: 'TRUART:',
	sources: [...source('rx', 'RX', 'receive (RX)'), ...source('tx', 'TX', 'transmit (TX)')],
	params: uartParams,
	applies: { qualifier: ['DATA'], data: ['DATA'] },
	sentinel: () => ({ data: DONT_CARE_BYTE }),
	check: (input) =>
		input.condition !== 'DATA' || (input.qualifier !== undefined && input.data !== undefined)
			? undefined
			: 'The Data condition requires qualifier and data. Provide both in the same request.',
};

// TRCAN:BAUD <value1>[,<value2>] spells the standard CAN rates and takes any other rate as CUSTOM,<rate> (p. 255).
// The public field is the rate in bit/s either way. The guide's list reads {5k,10k,20k,59k,100k,125k,250,500k,800k,1M}:
// 59k is not a CAN rate and 250 is below the CUSTOM minimum, so both are read as typos for 50k and 250k, and neither
// spelling is emitted. 50000, 59000 and 250000 stay reachable through CUSTOM, which the guide documents for the whole
// 5000 to 1000000 range.
const canBaud: Record<number, string> = {
	5000: '5k',
	10000: '10k',
	20000: '20k',
	100000: '100k',
	125000: '125k',
	500000: '500k',
	800000: '800k',
	1000000: '1M',
};

const decade: Record<string, number> = { k: 1e3, M: 1e6 };

const canRate = (raw: string): unknown => {
	const answer = parseFields(raw).at(-1) ?? raw;
	const match = /^(\d+(?:\.\d+)?)([kM])$/.exec(answer);
	return match ? Number(match[1]) * (decade[match[2] ?? ''] ?? 1) : count(answer);
};

const idBits: Record<string, number> = { '11BITS': 11, '29BITS': 29 };
const idBitsOf = (length: unknown) => (typeof length === 'string' ? idBits[length] : undefined);

// IDL before ID: the range of the identifier and the don't-care value that ignores it both follow the ID length, so
// the length goes first even though the guide documents ID on the earlier page.
const canParams: Param[] = [
	param(
		'condition',
		'CON',
		z.enum(['START', 'REMOTE', 'ID', 'ID_AND_DATA', 'ERROR']),
		'CAN trigger condition. Identifier and data fields depend on the selected condition.',
		stripHeader,
	),
	param('id_length', 'IDL', z.enum(['11BITS', '29BITS']), 'width of the identifier, standard or extended', stripHeader),
	param(
		'id',
		'ID',
		z.union([
			z
				.number()
				.int()
				.min(0)
				.max(2 ** 29 - 1),
			z.literal(ANY),
		]),
		'identifier to trigger on, 0 to 2047 with id_length 11BITS and 0 to 536870911 with 29BITS, or `any` to ignore it',
		count,
	),
	param('data', 'DATA', byteValue, 'first data byte, 0 to 255, or `any` to ignore it', count),
	param('data2', 'DAT2', byteValue, 'second data byte, 0 to 255, or `any` to ignore it', count),
	{
		...param(
			'baud',
			'BAUD',
			z.number().int().min(5_000).max(1_000_000),
			`Baud rate in bits per second from 5000 to 1000000. Common rates are ${Object.keys(canBaud).join(', ')}.`,
			canRate,
		),
		wire: (value) => canBaud[value as number] ?? `CUSTOM,${value}`,
	},
];

const can: Protocol = {
	prefix: 'TRCAN:',
	sources: source('canh', 'CANH', 'CAN high (CANH)'),
	params: canParams,
	applies: {
		id_length: ['ID', 'ID_AND_DATA'],
		id: ['ID', 'ID_AND_DATA'],
		data: ['ID_AND_DATA'],
		data2: ['ID_AND_DATA'],
	},
	sentinel: ({ id_length }) => {
		const bits = idBitsOf(id_length);
		return { data: DONT_CARE_BYTE, data2: DONT_CARE_BYTE, ...(bits !== undefined && { id: 2 ** bits }) };
	},
};

const canInput = protocolInput(can)
	.refine(({ id, id_length }: Values) => id === undefined || id_length !== undefined, {
		message: 'id requires id_length to determine its range. Provide both values in the same request.',
		path: ['id'],
	})
	.superRefine(({ id, id_length }: Values, ctx) => {
		const bits = idBitsOf(id_length);
		if (typeof id === 'number' && bits !== undefined && id >= 2 ** bits) {
			ctx.addIssue({
				code: 'custom',
				message: `id_length ${id_length} supports identifiers from 0 to ${2 ** bits - 1}. Use any to ignore the identifier.`,
				path: ['id'],
			});
		}
	});

// A LIN identifier is six bits, and 64 is the don't-care value one past it (p. 258).
const DONT_CARE_ID = 64;

const linParams: Param[] = [
	param(
		'condition',
		'CON',
		z.enum(['BREAK', 'ID', 'ID_AND_DATA', 'DATA_ERROR']),
		'BREAK (a break condition), ID (a search on the identifier), ID_AND_DATA (a search on the identifier and the data) or DATA_ERROR (an error frame)',
		stripHeader,
	),
	param(
		'id',
		'ID',
		z.union([
			z
				.number()
				.int()
				.min(0)
				.max(DONT_CARE_ID - 1),
			z.literal(ANY),
		]),
		'identifier to trigger on, 0 to 63, or `any` to ignore it',
		count,
	),
	param('data', 'DATA', byteValue, 'first data byte, 0 to 255, or `any` to ignore it', count),
	param('data2', 'DAT2', byteValue, 'second data byte, 0 to 255, or `any` to ignore it', count),
	baudRow([600, 1200, 2400, 4800, 9600, 19200], 300, 20_000),
];

const lin: Protocol = {
	prefix: 'TRLIN:',
	sources: source('src', 'SRC', 'LIN bus'),
	params: linParams,
	applies: { id: ['ID', 'ID_AND_DATA'], data: ['ID_AND_DATA'], data2: ['ID_AND_DATA'] },
	sentinel: () => ({ id: DONT_CARE_ID, data: DONT_CARE_BYTE, data2: DONT_CARE_BYTE }),
};

export const serialTriggerTools = [
	tool({
		name: 'get_i2c_trigger',
		description:
			'Read I2C serial trigger sources, thresholds, condition, address, data bytes, qualifier, direction, and search lengths. Ignored address or data values are returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) => readSerial(scope, i2c, 'I2C'),
	}),
	tool({
		name: 'configure_i2c_trigger',
		description:
			'Configure I2C serial trigger sources, thresholds, condition, address, data bytes, qualifier, direction, and search lengths. Analog sources require a threshold. Digital sources do not accept one. Criteria must match the selected condition. Use any to ignore address or data values. Select the Serial trigger type first. Choose the I2C bus on the scope. SDS1000X-E only.',
		input: protocolInput(i2c),
		annotations: mutating,
		handler: (input: Values, scope) => configureProtocol(scope, i2c, input),
	}),
	tool({
		name: 'get_spi_trigger',
		description:
			'Read SPI serial trigger sources, thresholds, clock edge and timeout, chip-select type, trigger line, pattern length, and bit order. The data pattern has no query form. Criteria are active only while the trigger type is Serial. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) => readSerial(scope, spi, 'SPI'),
	}),
	tool({
		name: 'configure_spi_trigger',
		description:
			'Configure SPI serial trigger sources, thresholds, clock edge and timeout, chip selection, trigger line, data pattern, and bit order. Analog sources require a threshold. Digital sources do not accept one. The data pattern must contain exactly data_length bits and has no query form. Select the Serial trigger type first. Choose the SPI bus on the scope. SDS1000X-E only.',
		input: spiInput,
		annotations: mutating,
		handler: (input: Values, scope) => configureProtocol(scope, spi, input),
	}),
	tool({
		name: 'get_uart_trigger',
		description:
			'Read UART serial trigger sources, thresholds, trigger line, condition, qualifier, data, baud rate, data length, parity, idle level, stop bits, and bit order. Ignored data is returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) => readSerial(scope, uart, 'UART'),
	}),
	tool({
		name: 'configure_uart_trigger',
		description:
			'Configure UART serial trigger sources, thresholds, trigger line, condition, qualifier, data, baud rate, data length, parity, idle level, stop bits, and bit order. Analog sources require a threshold. Digital sources do not accept one. Data and qualifier require the Data condition. Select the Serial trigger type first. Choose the UART bus on the scope. SDS1000X-E only.',
		input: protocolInput(uart),
		annotations: mutating,
		handler: (input: Values, scope) => configureProtocol(scope, uart, input),
	}),
	tool({
		name: 'get_can_trigger',
		description:
			'Read CAN serial trigger source, threshold, condition, identifier length, identifier, data bytes, and baud rate. Ignored identifier or data values are returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) => readSerial(scope, can, 'CAN'),
	}),
	tool({
		name: 'configure_can_trigger',
		description:
			'Configure CAN serial trigger source, threshold, condition, identifier length, identifier, data bytes, and baud rate. Analog sources require a threshold. Digital sources do not accept one. Identifier and data fields must match the selected condition. Use any to ignore them. Baud-rate support beyond common rates is unverified. Select the Serial trigger type first. Choose the CAN bus on the scope. SDS1000X-E only.',
		input: canInput,
		annotations: mutating,
		handler: (input: Values, scope) => configureProtocol(scope, can, input),
	}),
	tool({
		name: 'get_lin_trigger',
		description:
			'Read LIN serial trigger source, threshold, condition, identifier, data bytes, and baud rate. Ignored identifier or data values are returned as any. Criteria are active only while the trigger type is Serial. LIN baud-rate query behavior is unverified on hardware. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) => readSerial(scope, lin, 'LIN'),
	}),
	tool({
		name: 'configure_lin_trigger',
		description:
			'Configure LIN serial trigger source, threshold, condition, identifier, data bytes, and baud rate. Analog sources require a threshold. Digital sources do not accept one. Identifier and data fields must match the selected condition. Use any to ignore them. Select the Serial trigger type first. Choose the LIN bus on the scope. SDS1000X-E only.',
		input: protocolInput(lin),
		annotations: mutating,
		handler: (input: Values, scope) => configureProtocol(scope, lin, input),
	}),
];
