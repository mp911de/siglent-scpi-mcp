import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { asState, isOn, stripHeader } from '../../../scpi/values.ts';
import {
	applied,
	compare,
	flag,
	inputs,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { channels, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import {
	audioVariant,
	bitOrder,
	canBaud,
	canfdBaud,
	canfdDataBaud,
	choice,
	clockSource,
	clockThreshold,
	counted,
	csType,
	dataSource,
	dataThreshold,
	decodeOrders,
	decodeVariants,
	directed,
	flexBaud,
	gateSources,
	idleLevel,
	latchEdge,
	leftLevel,
	levelVolts,
	linBaud,
	lineSource,
	lineThreshold,
	measured,
	mixed,
	optionalLine,
	PICOSECOND,
	parity,
	shape,
	stopBitCount,
	uartBaud,
	VOLT,
} from './serial.ts';

const DECODE = ':DECode';
const LIST = ':DECode:LIST';
const RESULT = ':DECode:BUS<n>:RESult';
const COPY = ':DECode:BUS<n>:COPY';

// The list is one screen of the decoded frames, so the selected line is bounded by the frames the scope has decoded
// rather than by anything the guide prints (p. 94); this keeps the value inside what a line number can mean at all.
const listLines = z.number().int().min(1).max(7);
const listScroll = z.number().int().min(1).max(1_000_000);

const lists = ['OFF', 'D1', 'D2'] as const;
const formats = ['BINary', 'DECimal', 'HEX', 'ASCii'] as const;
const copies = ['FROMtrigger', 'TOTRigger'] as const;
// p. 98 takes thirteen protocols in its command syntax and prints nine of them in its response format; the wider set
// is what may be written. The chapter index (p. 90) marks six of the parameter groups [Option] and leaves FLEXray
// out of the index altogether although its section (p. 141) exists and is marked so too.
const protocols = [
	'IIC',
	'SPI',
	'UART',
	'CAN',
	'LIN',
	'FLEXray',
	'CANFd',
	'IIS',
	'M1553',
	'SENT',
	'MANchester',
	'ARINC429',
	'USB20',
] as const;
const optional: readonly string[] = ['FLEXray', 'CANFd', 'IIS', 'M1553', 'SENT', 'MANchester'];

const DATA_LENGTH = 'Bits in one decoded word. The range depends on the selected protocol';

const annotated = ['ALL', 'LEFT', 'RIGHt'] as const;
const messageFormats = ['NIBBles', 'FSIGnal', 'SSERial', 'ESERial'] as const;
const displays = ['WORD', 'BIT'] as const;

const size32 = z.number().int().min(0).max(32);

const source = choice('source', mixed, 'Bus source. Use an analog channel C1-C4 or digital channel D0-D15');
const analogSource = choice('source', channels, 'Bus source. Use an analog channel C1-C4');
const threshold = measured('threshold', levelVolts, 'threshold of the bus source in volts', VOLT);
const annotate = choice('annotate', annotated, 'IIS channel annotated on screen: ALL, LEFT or RIGHt');
const startBit = counted('start_bit', z.number().int().min(0).max(31), 'first bit of the IIS data word, 0 to 31');
const upperThreshold = measured(
	'upper_threshold',
	levelVolts,
	'upper threshold of the M1553 source in volts, which the scope keeps at or above lower_threshold',
	VOLT,
);
const lowerThreshold = measured(
	'lower_threshold',
	levelVolts,
	'lower threshold of the M1553 source in volts, which the scope keeps at or below upper_threshold',
	VOLT,
);
const messageFormat = choice(
	'message_format',
	messageFormats,
	'SENT message format: NIBBles, FSIGnal fast signal, SSERial short serial or ESERial enhanced serial',
);
const clockPeriod = measured(
	'clock_period',
	z.number().min(500e-9).max(300e-6),
	'SENT clock tick in seconds, 500 ns to 300 us',
	PICOSECOND,
);
const tolerance = counted('tolerance', z.number().int().min(1).max(25), 'SENT clock tolerance in percent, 1 to 25');
const nibbles = counted('nibbles', z.number().int().min(3).max(8), 'nibbles of one SENT message, 3 to 8');
const manchesterBaud = counted(
	'baud',
	z.number().int().min(500).max(5_000_000),
	'Manchester baud rate in bits per second, 500 to 5000000. This bus takes no preset',
);
const polarity = choice('polarity', directed, 'Manchester edge that encodes a logic 1: RISing or FALLing');
const idleBits = counted('idle_bits', z.number().int().min(2).max(32), 'idle bits of the Manchester bus, 2 to 32');
const startEdge = counted('start_edge', z.number().int().min(1).max(32), 'start edge of the Manchester bus, 1 to 32');
const syncSize = counted('sync_size', size32, 'sync size of the Manchester bus, 0 to 32');
const headerSize = counted('header_size', size32, 'header size of the Manchester bus, 0 to 32');
const trailerSize = counted('trailer_size', size32, 'trailer size of the Manchester bus, 0 to 32');
const wordSize = counted('word_size', z.number().int().min(2).max(8), 'word size of the Manchester bus, 2 to 8');
const dataSize = counted(
	'data_size',
	z.number().int().min(1).max(255),
	'data word length of the Manchester bus, 1 to 255',
);
const displayFormat = choice('display_format', displays, 'Manchester display format: WORD or BIT');

// One protocol is one row: its lines with their thresholds, then the frame format that says how the bus is read,
// then the lengths that bound its values. A protocol the guide documents no parameter command for carries no row,
// and selecting it is then everything this driver can do for it.
const rows: Record<string, Param[]> = {
	IIC: [
		clockSource(':DECode:BUS<n>:IIC:SCLSource'),
		clockThreshold(':DECode:BUS<n>:IIC:SCLThreshold'),
		dataSource(':DECode:BUS<n>:IIC:SDASource'),
		dataThreshold(':DECode:BUS<n>:IIC:SDAThreshold'),
		flag('read_write', ':DECode:BUS<n>:IIC:RWBit', 'whether the decoded address carries its read and write bit', isOn),
	],
	SPI: [
		clockSource(':DECode:BUS<n>:SPI:CLKSource'),
		clockThreshold(':DECode:BUS<n>:SPI:CLKThreshold'),
		lineSource('mosi_source', 'SPI MOSI', optionalLine)(':DECode:BUS<n>:SPI:MOSISource'),
		lineThreshold('mosi_threshold', 'SPI MOSI')(':DECode:BUS<n>:SPI:MOSIThreshold'),
		lineSource('miso_source', 'SPI MISO', optionalLine)(':DECode:BUS<n>:SPI:MISOSource'),
		lineThreshold('miso_threshold', 'SPI MISO')(':DECode:BUS<n>:SPI:MISOThreshold'),
		lineSource('cs_source', 'SPI CS')(':DECode:BUS<n>:SPI:CSSource'),
		lineThreshold('cs_threshold', 'SPI CS')(':DECode:BUS<n>:SPI:CSThreshold'),
		lineSource('ncs_source', 'SPI ~CS')(':DECode:BUS<n>:SPI:NCSSource'),
		lineThreshold('ncs_threshold', 'SPI ~CS')(':DECode:BUS<n>:SPI:NCSThreshold'),
		csType(':DECode:BUS<n>:SPI:CSTYpe'),
		latchEdge(':DECode:BUS<n>:SPI:LATChedge'),
		bitOrder(decodeOrders)(':DECode:BUS<n>:SPI:BITorder'),
		counted('data_length', z.number().int().min(4).max(32), DATA_LENGTH)(':DECode:BUS<n>:SPI:DLENgth'),
	],
	UART: [
		lineSource('rx_source', 'UART RX', optionalLine)(':DECode:BUS<n>:UART:RXSource'),
		lineThreshold('rx_threshold', 'UART RX')(':DECode:BUS<n>:UART:RXThreshold'),
		lineSource('tx_source', 'UART TX', optionalLine)(':DECode:BUS<n>:UART:TXSource'),
		lineThreshold('tx_threshold', 'UART TX')(':DECode:BUS<n>:UART:TXThreshold'),
		uartBaud(':DECode:BUS<n>:UART:BAUD'),
		bitOrder(decodeOrders)(':DECode:BUS<n>:UART:BITorder'),
		parity(':DECode:BUS<n>:UART:PARity'),
		stopBitCount(':DECode:BUS<n>:UART:STOP'),
		idleLevel(':DECode:BUS<n>:UART:IDLE'),
		counted('data_length', z.number().int().min(5).max(8), DATA_LENGTH)(':DECode:BUS<n>:UART:DLENgth'),
	],
	CAN: [
		source(':DECode:BUS<n>:CAN:SOURce'),
		threshold(':DECode:BUS<n>:CAN:THReshold'),
		canBaud(':DECode:BUS<n>:CAN:BAUD'),
	],
	LIN: [
		source(':DECode:BUS<n>:LIN:SOURce'),
		threshold(':DECode:BUS<n>:LIN:THReshold'),
		linBaud(':DECode:BUS<n>:LIN:BAUD'),
	],
	FLEXray: [
		source(':DECode:BUS<n>:FLEXray:SOURce'),
		threshold(':DECode:BUS<n>:FLEXray:THReshold'),
		flexBaud(':DECode:BUS<n>:FLEXray:BAUD'),
	],
	CANFd: [
		source(':DECode:BUS<n>:CANFd:SOURce'),
		threshold(':DECode:BUS<n>:CANFd:THReshold'),
		canfdBaud(':DECode:BUS<n>:CANFd:BAUDNominal'),
		canfdDataBaud()(':DECode:BUS<n>:CANFd:BAUDData'),
	],
	IIS: [
		clockSource(':DECode:BUS<n>:IIS:BCLKSource'),
		clockThreshold(':DECode:BUS<n>:IIS:BCLKThreshold'),
		lineSource('ws_source', 'IIS word select')(':DECode:BUS<n>:IIS:WSSource'),
		lineThreshold('ws_threshold', 'IIS word select')(':DECode:BUS<n>:IIS:WSTHreshold'),
		dataSource(':DECode:BUS<n>:IIS:DSource'),
		dataThreshold(':DECode:BUS<n>:IIS:DTHReshold'),
		audioVariant(decodeVariants)(':DECode:BUS<n>:IIS:AVARiant'),
		latchEdge(':DECode:BUS<n>:IIS:LATChedge'),
		bitOrder(decodeOrders)(':DECode:BUS<n>:IIS:BITorder'),
		leftLevel(':DECode:BUS<n>:IIS:LCH'),
		annotate(':DECode:BUS<n>:IIS:ANNotate'),
		startBit(':DECode:BUS<n>:IIS:SBIT'),
		counted('data_length', z.number().int().min(1).max(32), DATA_LENGTH)(':DECode:BUS<n>:IIS:DLENgth'),
	],
	M1553: [
		analogSource(':DECode:BUS<n>:M1553:SOURce'),
		upperThreshold(':DECode:BUS<n>:M1553:UTHReshold'),
		lowerThreshold(':DECode:BUS<n>:M1553:LTHReshold'),
	],
	SENT: [
		source(':DECode:BUS<n>:SENT:SOURce'),
		threshold(':DECode:BUS<n>:SENT:THReshold'),
		messageFormat(':DECode:BUS<n>:SENT:FORMat'),
		idleLevel(':DECode:BUS<n>:SENT:IDLE'),
		flag('crc_2010', ':DECode:BUS<n>:SENT:CRC', 'the 2010 SENT CRC format. Off selects the 2008 format', isOn),
		flag('pause_pulse', ':DECode:BUS<n>:SENT:PPULse', 'the SENT pause pulse', isOn),
		clockPeriod(':DECode:BUS<n>:SENT:CLOCk'),
		tolerance(':DECode:BUS<n>:SENT:TOLerance'),
		nibbles(':DECode:BUS<n>:SENT:LENGth'),
	],
	MANchester: [
		source(':DECode:BUS<n>:MANChester:SOURce'),
		threshold(':DECode:BUS<n>:MANChester:THReshold'),
		manchesterBaud(':DECode:BUS<n>:MANChester:BAUD'),
		polarity(':DECode:BUS<n>:MANChester:POLarity'),
		idleLevel(':DECode:BUS<n>:MANChester:IDLE'),
		bitOrder(decodeOrders)(':DECode:BUS<n>:MANChester:BITorder'),
		displayFormat(':DECode:BUS<n>:MANChester:DISPlay'),
		idleBits(':DECode:BUS<n>:MANChester:IBITs'),
		startEdge(':DECode:BUS<n>:MANChester:STARt'),
		syncSize(':DECode:BUS<n>:MANChester:SSIZe'),
		headerSize(':DECode:BUS<n>:MANChester:HSIZe'),
		trailerSize(':DECode:BUS<n>:MANChester:TSIZe'),
		wordSize(':DECode:BUS<n>:MANChester:WSIZe'),
		dataSize(':DECode:BUS<n>:MANChester:DSIZe'),
	],
};

const globals: Param[] = [
	flag('enabled', DECODE, 'the decode function itself', isOn),
	param(
		'list',
		LIST,
		z.enum(lists),
		'Decode list on screen. Off hides it, D1 shows the list of bus 1 and D2 the list of bus 2',
		(raw) => asState(raw, lists),
	),
	counted('list_lines', listLines, 'Lines the decode list shows on screen, 1 to 7')(':DECode:LIST:LINE'),
	counted(
		'list_scroll',
		listScroll,
		'Line the decode list selects. The scope bounds it by the frames it decoded',
	)(':DECode:LIST:SCRoll'),
];

const busRows: Param[] = [
	flag('bus_enabled', ':DECode:BUS<n>', 'the decode bus itself', isOn),
	choice(
		'protocol',
		protocols,
		'Protocol the bus is decoded as. The selection determines which parameters apply',
	)(':DECode:BUS<n>:PROTocol'),
	choice('format', formats, 'Number format the decoded values are shown and answered in')(':DECode:BUS<n>:FORMat'),
];

const settingNames = new Set([...globals, ...busRows].map(({ name }) => name));

const pick = (params: readonly Param[], input: Values): Values =>
	Object.fromEntries(params.map(({ name }) => [name, input[name]]));

const at = (bus: number, mnemonic: string): string => mnemonic.replace('<n>', String(bus));
const on = (bus: number, params: readonly Param[]): Param[] =>
	params.map((row) => ({ ...row, mnemonic: at(bus, row.mnemonic) }));

const busInput = z.literal([1, 2]).describe('Decode bus 1 or 2');

function check(input: Values, ctx: z.RefinementCtx): void {
	const table = new Map((rows[String(input.protocol)] ?? []).map((row) => [row.name, row]));
	for (const [name, value] of Object.entries(input)) {
		if (value === undefined || name === 'bus' || settingNames.has(name)) continue;
		const row = table.get(name);
		if (!row) {
			const message =
				input.protocol === undefined
					? `${name} belongs to a protocol. Add protocol so the bus is decoded as the one the setting belongs to`
					: `${name} is not supported by protocol ${input.protocol}. Remove it or choose a compatible protocol`;
			ctx.addIssue({ code: 'custom', message, path: [name] });
		} else if (!row.schema.safeParse(value).success) {
			ctx.addIssue({ code: 'custom', message: `Protocol ${input.protocol} requires ${row.description}`, path: [name] });
		}
	}
	if (
		typeof input.list_scroll === 'number' &&
		typeof input.list_lines === 'number' &&
		input.list_scroll > input.list_lines
	) {
		ctx.addIssue({
			code: 'custom',
			message: 'list_scroll must not exceed list_lines. Lower list_scroll or raise list_lines',
			path: ['list_scroll'],
		});
	}
}

// Only the values of the protocol rows are gated for a source: the decode list is named D1 or D2 too, and a list
// selection is not a digital channel.
const gate = (scope: ScpiScope, protocol: unknown, input: Values): void => {
	if (typeof protocol === 'string' && optional.includes(protocol)) {
		scope.warn(
			`The ${protocol} decoder requires an optional feature. Availability cannot be determined from model identity`,
		);
	}
	gateSources(scope, input);
};

// A decode list can hold thousands of frames, so the answer is parsed to a bounded slice and never returned whole.
const MAX_TEXT = 1 << 20;
const MAX_FRAMES = 500;

export const decodeTools = [
	tool({
		name: 'get_decode',
		description:
			'Read the decode function, the on-screen list, and one bus with the parameters of the protocol it is set to. Parameters of the other protocols are left unread. A protocol without typed parameters returns the bus state alone with a warning.',
		input: z.strictObject({ bus: busInput }),
		annotations: readOnly,
		handler: ({ bus }, scope) =>
			scope.execute(async (session) => {
				const state: Values = {
					...(await readback(session, globals)),
					bus,
					...(await readback(session, on(bus, busRows))),
				};
				const protocol = state.protocol;
				const table = typeof protocol === 'string' ? rows[protocol] : undefined;
				gate(scope, protocol, {});
				if (!table) {
					scope.warn(
						`This driver reads no parameter of protocol ${JSON.stringify(protocol)}. Only the decode and bus state were read`,
					);
				}
				return { ...state, ...(table ? await readback(session, on(bus, table)) : {}) };
			}),
	}),
	tool({
		name: 'configure_decode',
		description:
			'Enable decoding, set the on-screen list, and configure one bus with the protocol it is decoded as and that protocol parameters, then read back the requested values. Each parameter must be supported by the selected protocol. Thresholds adjusted by the scope are returned with a warning. Optional protocols return an availability warning.',
		input: z
			.strictObject({
				bus: busInput,
				...inputs(globals),
				...inputs(busRows),
				...shape(Object.values(rows).flat()),
			})
			.superRefine(check),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const bus = Number(input.bus);
			const protocolRows = rows[String(input.protocol)] ?? [];
			const table = on(bus, [...busRows, ...protocolRows]);
			const commands = plan(...settings(globals, input), ...settings(table, input));
			return scope.execute(async (session) => {
				gate(scope, input.protocol, pick(protocolRows, input));
				if (protocolRows.length === 0 && input.protocol !== undefined) {
					scope.warn(`This driver writes no parameter of protocol ${input.protocol}. Only the protocol itself was set`);
				}
				for (const command of commands) await session.command(command);
				const state = {
					bus,
					...(await readback(session, applied(globals, input))),
					...(await readback(session, applied(table, input))),
				};
				compare(
					scope,
					[...globals, ...table],
					input,
					state,
					'a threshold the source and the model cannot take is moved to the nearest one they can',
				);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'copy_decode_settings',
		description:
			'Copy the serial settings between one decode bus and the trigger. From Trigger overwrites the bus settings with the trigger ones, To Trigger overwrites the trigger settings with the bus ones. The overwritten settings are not saved anywhere and the command has no query form.',
		input: z.strictObject({
			bus: busInput,
			direction: z
				.enum(copies)
				.describe(
					'From Trigger copies the trigger setup into the bus. To Trigger copies the bus setup into the trigger',
				),
		}),
		annotations: destructive,
		handler: ({ bus, direction }, scope) => {
			const commands = [`${at(bus, COPY)} ${direction}`];
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				return { commands, write_only: [COPY] };
			});
		},
	}),
	tool({
		name: 'read_decode_result',
		description:
			'Read up to 500 decoded frames from one bus in its selected number format. Returns the protocol, format, column names, total frame count, and the requested slice. The decode function and bus must both be on. Enable them with configure_decode first.',
		input: z.strictObject({
			bus: busInput,
			first_frame: z.int().min(0).max(1_000_000).default(0).describe('Index of the first frame to return'),
			max_frames: z
				.int()
				.min(1)
				.max(MAX_FRAMES)
				.default(50)
				.describe('Frames to return at most, counted from first_frame'),
		}),
		annotations: readOnly,
		handler: ({ bus, first_frame, max_frames }, scope) =>
			scope.execute(async (session) => {
				const enabled = isOn(await session.query(`${DECODE}?`));
				const running = isOn(await session.query(`${at(bus, ':DECode:BUS<n>')}?`));
				if (!enabled || !running) {
					throw new Error(
						`Decoding is off on bus ${bus}. Enable it with configure_decode {bus: ${bus}, enabled: true, bus_enabled: true} first`,
					);
				}
				const protocol = asState(await session.query(`${at(bus, ':DECode:BUS<n>:PROTocol')}?`), protocols);
				const format = asState(await session.query(`${at(bus, ':DECode:BUS<n>:FORMat')}?`), formats);
				const raw = await session.query(`${at(bus, RESULT)}?`);

				let text = stripHeader(raw);
				if (text.length > MAX_TEXT) {
					scope.warn(
						`The decode list answered ${text.length} characters and only the first ${MAX_TEXT} are parsed. Read fewer frames at the scope`,
					);
					text = text.slice(0, text.lastIndexOf(';', MAX_TEXT) + 1);
				}
				const records = text
					.split(';')
					.map((record) => record.trim())
					.filter((record) => record !== '');
				const [header = '', ...frames] = records;
				const columns = header.split(',').map((column) => column.trim());
				const returned = frames.slice(first_frame, first_frame + max_frames).map((frame) => {
					const fields = frame.split(',').map((field) => field.trim());
					return fields.length === columns.length
						? Object.fromEntries(columns.map((column, index) => [column, fields[index]]))
						: { raw: frame };
				});
				if (frames.length === 0) {
					scope.warn(`Bus ${bus} returned column names ${JSON.stringify(header)} but no decoded frames`);
				}
				return {
					bus,
					protocol,
					format,
					columns,
					frames: {
						total: frames.length,
						returned: returned.length,
						first: first_frame,
						truncated: first_frame + returned.length < frames.length,
					},
					rows: returned,
				};
			}),
	}),
];
