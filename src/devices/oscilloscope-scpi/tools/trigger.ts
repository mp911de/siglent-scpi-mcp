import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, isOn, parseFields, stripHeader } from '../../../scpi/values.ts';
import { applied, compare, inputs, type Param, param, readback, settings, type Values } from '../../../tools/params.ts';
import { channels, type ScpiScope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import {
	alternating,
	audioVariant,
	bitOrder,
	bounds,
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
	directed,
	flexBaud,
	gateSources,
	highLow,
	idleLevel,
	latchEdge,
	leftLevel,
	levelHigh as levelHighOf,
	levelLow as levelLowOf,
	level as levelOf,
	levelVolts,
	limit,
	limitSeconds,
	linBaud,
	lineSource,
	lineThreshold,
	measured,
	mixed,
	PICOSECOND,
	parity,
	polarities,
	selected,
	shape,
	stopBitCount,
	timeLower,
	timeUpper,
	triggerOrders,
	triggerVariants,
	uartBaud,
	VOLT,
} from './serial.ts';

const MODE = ':TRIGger:MODE';
const STATUS = ':TRIGger:STATus';
const FREQUENCY = ':TRIGger:FREQuency';
const RUN = ':TRIGger:RUN';
const STOP = ':TRIGger:STOP';
const TYPE = ':TRIGger:TYPE';

const modes = ['AUTO', 'NORMal', 'SINGle', 'FTRIG'] as const;
const statuses = ['Arm', 'Ready', 'Auto', "Trig'd", 'Stop', 'Roll'] as const;
const couplings = ['DC', 'AC', 'LFREJect', 'HFREJect'] as const;
const holdoffs = ['OFF', 'EVENts', 'TIME'] as const;
const starts = ['LAST_TRIG', 'ACQ_START'] as const;
const impedances = ['ONEMeg', 'FIFTy'] as const;
const windows = ['ABSolute', 'RELative'] as const;
const overtimes = ['EDGE', 'STATe'] as const;
const standards = [
	'NTSC',
	'PAL',
	'P720L50',
	'P720L60',
	'P1080L50',
	'P1080L60',
	'I1080L50',
	'I1080L60',
	'CUSTom',
] as const;
const syncs = ['SELect', 'ANY'] as const;
const rates = ['25Hz', '30Hz', '50Hz', '60Hz'] as const;
const combinations = ['AND', 'OR', 'NAND', 'NOR'] as const;
const qualifiers = ['STATe', 'STATE_DLY', 'EDGE', 'EDGE_DLY'] as const;
const holds = ['SETup', 'HOLD'] as const;
const logic = ['X', 'L', 'H'] as const;

const bits = ['0', '1', 'X'] as const;
const iicConditions = ['STARt', 'STOP', 'RESTart', 'NACK', 'EEPRom', '7ADDRess', '10ADDRess', 'DLENgth'] as const;
const uartConditions = ['STARt', 'STOP', 'DATA', 'ERRor'] as const;
const canConditions = ['STARt', 'REMote', 'ID', 'ID_AND_DATA', 'ERRor'] as const;
const linConditions = ['BReak', 'ID', 'ID_AND_DATA', 'DATA_ERROR'] as const;
const flexConditions = ['TSS', 'FRAMe', 'SYMBol', 'ERRor'] as const;
const iisConditions = ['DATA', 'MUTE', 'CLIP', 'GLITch', 'RISing', 'FALLing'] as const;
const comparisons = ['EQUal', 'GREaterthan', 'LESSthan'] as const;
const cycleComparisons = ['ANY', ...comparisons] as const;
const addressLengths = ['7BIT', '10BIT'] as const;
const directions = ['WRITe', 'READ', 'ANY'] as const;
const idLengths = ['11BITS', '29BITS'] as const;
const frameTypes = ['BOTH', 'CAN', 'CANFd'] as const;
const spiLines = ['MISO', 'MOSI'] as const;
const uartLines = ['RX', 'TX'] as const;
const sides = ['LEFT', 'RIGHT'] as const;

const CANFD_DATA_BAUD = 'CAN FD data-phase baud rate. Applies to Both and CAN FD frame types';

const externals = [...mixed, 'EX', 'EX5', 'LINE'] as const;

// The guide bounds a level by the volts per division and the offset of the source (p. 428) and a time per model
// (pp. 424, 444, 506); these keep a value inside what a trigger setting can mean at all, take the widest range any
// model the guide lists documents, and leave the rest to the scope, which moves what it cannot take to the nearest
// value it can and comes back as a warning.
const holdoffSeconds = z.number().min(8e-9).max(30);
const eventCount = z.number().int().min(1).max(100_000_000);
const idleSeconds = z.number().min(8e-9).max(20);
const edgeIndex = z.number().int().min(1).max(65_535);
const lineTotal = z.number().int().min(300).max(2000);
const lineIndex = z.number().int().min(1).max(1125);
const fieldIndex = z.literal([1, 2]);
const perFrame = z.literal([1, 2, 4, 8]);
const rejection = z.boolean();

// The serial ranges the guide prints per command; the don't-care values it documents (256 for a data byte, 64 and
// 536870912 for an identifier, 2048 for a FlexRay frame) are the top of each range and stay reachable.
const byteValue = z.number().int().min(0).max(256);
const iicAddress = z.number().int().min(0).max(127);
const canIds = z.number().int().min(0).max(536_870_912);
const linIds = z.number().int().min(0).max(64);
const linErrorIds = z.number().int().min(0).max(63);
const flexIds = z.number().int().min(0).max(2048);
const cycles = z.number().int().min(0).max(63);
const audioValues = z.number().int().min(0).max(4_294_967_296);
const repetitions = z.literal([1, 2, 4, 8, 16, 32, 64]);
const revisions = z.literal([0, 1]);
const spiPattern = z.array(z.enum(bits)).min(4).max(96);

const optionsOf = (state: string): readonly string[] => (state.startsWith('STAT') ? highLow : directed);

const logicStates = z.array(z.enum(logic)).min(1).max(mixed.length);
const sourceLevel = z.object({ source: z.enum(channels), level: levelVolts });
const qualifiedType = z
	.object({ state: z.enum(qualifiers), option: z.enum([...highLow, ...directed]).optional() })
	.refine(
		({ state, option }) => option === undefined || optionsOf(state).includes(option),
		'State and State Delay require Low or High. Edge and Edge Delay require Rising or Falling',
	);

const asQualified = (raw: string): Values => {
	const [state = '', option] = parseFields(raw);
	return option === undefined ? { state } : { state, option };
};

// A serial state the guide writes as 0 or 1 rather than the ON and OFF of the rest of the tree.
const switched =
	(name: string, what: string) =>
	(mnemonic: string): Param => ({
		...param(name, mnemonic, z.boolean(), what, (raw) => stripHeader(raw) === '1'),
		wire: (value) => (value ? '1' : '0'),
	});

const anySource = choice(
	'source',
	externals,
	'Trigger source. Supports channels C1-C4, digital channels D0-D15 on mixed-signal models, external inputs and line power. Available sources depend on the trigger type',
);
const mixedSource = choice('source', mixed, 'Trigger source. Use an analog channel C1-C4 or digital channel D0-D15');
const analogSource = choice('source', channels, 'Trigger source. Use an analog channel C1-C4');

const alternatingSlope = choice(
	'slope',
	alternating,
	'Trigger edge. Alternate switches between rising and falling edges. Interval and Dropout support only Rising or Falling',
);
const directedSlope = choice('slope', directed, 'Trigger edge. Choose Rising or Falling');

const coupling = choice(
	'coupling',
	couplings,
	'Trigger path coupling. DC passes the signal unchanged, AC blocks its DC offset, Low Frequency Reject reduces mains hum and High Frequency Reject reduces high-frequency noise',
);
const noiseReject = (mnemonic: string): Param =>
	param('noise_reject', mnemonic, rejection, 'noise rejection, a hysteresis band around the trigger level', isOn);
const holdoff = choice(
	'holdoff',
	holdoffs,
	'Holdoff kind. Off re-arms immediately, Events waits for holdoff_events and Time waits for holdoff_time',
);
const holdoffEvents = counted(
	'holdoff_events',
	eventCount,
	'Trigger events counted before re-arming. Used by Events holdoff',
);
const holdoffTime = measured(
	'holdoff_time',
	holdoffSeconds,
	'Seconds before the trigger re-arms. Used by Time holdoff. SHS models support a narrower range',
	PICOSECOND,
);
const holdoffStart = choice(
	'holdoff_start',
	starts,
	'Where holdoff starts counting. Last Trigger starts at the previous trigger. Acquisition Start begins with acquisition',
);
const impedance = choice(
	'impedance',
	impedances,
	'External trigger input impedance. Applies only to EX and EX5 sources',
);
const level = levelOf('Trigger');
const levelHigh = levelHighOf('Trigger');
const levelLow = levelLowOf('Trigger');
const centerLevel = measured(
	'center_level',
	levelVolts,
	'Center of the window in volts. Requires window_type Relative.',
	VOLT,
);
const deltaLevel = measured(
	'delta_level',
	levelVolts,
	'Half-height of the window in volts on either side of center_level. Requires window_type Relative.',
	VOLT,
);
const polarity = choice('polarity', polarities, 'pulse polarity the scope triggers on: POSitive or NEGative');
const windowType = choice(
	'window_type',
	windows,
	'How the trigger window is defined. Absolute uses level_high and level_low. Relative uses center_level and delta_level',
);
const overtime = choice(
	'dropout_type',
	overtimes,
	'Dropout kind. Edge triggers when no edge arrives within dropout_time. State triggers when the signal stays at the level for that time',
);
const dropoutTime = measured('dropout_time', limitSeconds, 'dropout time in seconds', PICOSECOND);
const videoStandard = choice(
	'standard',
	standards,
	'Video standard. The selected standard determines which video parameters apply',
);
const sync = choice(
	'sync',
	syncs,
	'Sync mode. Select uses the configured line and field. Any triggers on any sync pulse',
);
const frameRate = choice('frame_rate', rates, 'frame rate of the custom standard: 25Hz, 30Hz, 50Hz or 60Hz');
const lineCount = counted('line_count', lineTotal, 'lines of the custom standard, 300 to 2000');
const fieldCount = counted('field_count', perFrame, 'fields of the custom standard: 1, 2, 4 or 8');
const interlace = counted('interlace', perFrame, 'interlace of the custom standard: 1, 2, 4 or 8 to one');
const field = counted(
	'field',
	fieldIndex,
	'Synchronous trigger field 1 or 2. Available for interlaced video standards',
);
const line = counted(
	'line',
	lineIndex,
	'Synchronous trigger line. The valid range depends on the video standard and field and is checked by the scope',
);
const idleTime = measured(
	'idle_time',
	idleSeconds,
	'idle time in seconds the signal must rest before the edges are counted, 8 ns to 20 s',
	PICOSECOND,
);
const edgeCount = counted('edge_count', edgeIndex, 'edge counted from the end of the idle time, 1 to 65535');
const dataState = choice('data_state', highLow, 'level the data source is tested for: LOW or HIGH');
const setupHold = choice(
	'setup_hold',
	holds,
	'What the time bounds measure. Setup measures before the clock edge. Hold measures after it',
);
const edgeSource = choice(
	'edge_source',
	mixed,
	'edge source of the qualified trigger: an analog channel C1-C4 or a digital channel D0-D15',
);
const edgeLevel = measured('edge_level', levelVolts, 'trigger level of the edge source in volts', VOLT);
const edgeSlope = choice('edge_slope', directed, 'Rising or falling edge of the edge source.');
const qualifySource = choice(
	'qualify_source',
	mixed,
	'qualify source of the qualified trigger: an analog channel C1-C4 or a digital channel D0-D15',
);
const qualifyLevel = measured('qualify_level', levelVolts, 'level of the qualify source in volts', VOLT);
const source2 = choice(
	'source2',
	mixed,
	'source B of the delay trigger: an analog channel C1-C4 or a digital channel D0-D15',
);
const slope2 = choice('slope2', directed, 'Rising or falling edge of source B.');
const level2 = measured('level2', levelVolts, 'trigger level of source B in volts', VOLT);
const combination = choice(
	'logic',
	combinations,
	'Boolean combination of source states. Time limits apply only to And and Nor',
);
const pattern = (mnemonic: string): Param => ({
	...param(
		'pattern',
		mnemonic,
		logicStates,
		'State tested for each source, ordered C1-C4 then D0-D15. H is high, L is low and X is either',
		parseFields,
	),
	wire: (value) => (value as string[]).join(','),
});
const channelLevel = (mnemonic: string): Param => ({
	...param(
		'channel_level',
		mnemonic,
		sourceLevel,
		'Trigger level of one analog source in volts. This value is written but not read back',
	),
	wire: (value) => {
		const { source, level } = value as { source: string; level: number };
		return `${source},${nr3(level)}`;
	},
});
const qualifiedState = (mnemonic: string): Param => ({
	...param(
		'qualified_type',
		mnemonic,
		qualifiedType,
		'Condition applied to the qualify source. State conditions use Low or High. Edge conditions use Rising or Falling. Time limits apply to delayed conditions',
		asQualified,
	),
	wire: (value) => {
		const { state, option } = value as { state: string; option?: string };
		return option ? `${state},${option}` : state;
	},
});

// The serial buses of pp. 577-682. A bus is described the same way every time, which is the order it is sent in:
// its lines with their thresholds, then the frame format that says how the bus is read, then the lengths that bound
// its values, then the condition that picks which of those values apply, then the values themselves. A parameter
// the guide gives a meaning only under one condition says so in its own text; nothing here refuses it beside
// another, because the guide states the dependency as prose and the scope simply ignores what does not apply.
const threshold = measured('threshold', levelVolts, 'threshold of the trigger source in volts', VOLT);
const rxSource = lineSource('rx_source', 'UART RX');
const rxThreshold = lineThreshold('rx_threshold', 'UART RX');
const txSource = lineSource('tx_source', 'UART TX');
const txThreshold = lineThreshold('tx_threshold', 'UART TX');
const mosiSource = lineSource('mosi_source', 'SPI MOSI');
const mosiThreshold = lineThreshold('mosi_threshold', 'SPI MOSI');
const misoSource = lineSource('miso_source', 'SPI MISO');
const misoThreshold = lineThreshold('miso_threshold', 'SPI MISO');
const csSource = lineSource('cs_source', 'SPI CS');
const csThreshold = lineThreshold('cs_threshold', 'SPI CS');
const ncsSource = lineSource('ncs_source', 'SPI ~CS');
const ncsThreshold = lineThreshold('ncs_threshold', 'SPI ~CS');
const wsSource = lineSource('ws_source', 'IIS word select');
const wsThreshold = lineThreshold('ws_threshold', 'IIS word select');

const CONDITION =
	'Bus condition to trigger on. Available conditions depend on the selected protocol. SPI uses data pattern instead';
const iicCondition = choice('condition', iicConditions, CONDITION);
const uartCondition = choice('condition', uartConditions, CONDITION);
const canCondition = choice('condition', canConditions, CONDITION);
const linCondition = choice('condition', linConditions, CONDITION);
const flexCondition = choice('condition', flexConditions, CONDITION);
const iisCondition = choice('condition', iisConditions, CONDITION);

const COMPARE = 'How the value is compared. Available comparisons depend on the selected protocol and condition';
const comparison = choice('compare', comparisons, COMPARE);
const cycleComparison = choice('compare', cycleComparisons, COMPARE);

const DATA =
	'Data value matched by the bus trigger. The allowed range depends on the protocol and data length. The maximum schema value means any value';
const data = counted('data', byteValue, DATA);
const data2 = counted('data2', byteValue, `second ${DATA}`);
const DATA_LENGTH = 'Length matched by the trigger. The unit and range depend on the selected protocol';
const iicDataLength = counted('data_length', z.number().int().min(1).max(12), DATA_LENGTH);
const spiDataLength = counted('data_length', z.number().int().min(4).max(96), DATA_LENGTH);
const uartDataLength = counted('data_length', z.number().int().min(5).max(8), DATA_LENGTH);
const linDataLength = counted('data_length', z.number().int().min(1).max(8), DATA_LENGTH);
const iisDataLength = counted('data_length', z.number().int().min(1).max(32), DATA_LENGTH);

const IDENTIFIER =
	'Frame identifier. The allowed range depends on the selected protocol and identifier length. The maximum schema value means any identifier';
const canIdentifier = counted('id', canIds, IDENTIFIER);
const linIdentifier = counted('id', linIds, IDENTIFIER);
const flexIdentifier = counted('id', flexIds, IDENTIFIER);
const idLength = choice('id_length', idLengths, 'length of the CAN and CAN FD identifier: 11BITS or 29BITS');
const frameType = choice(
	'frame_type',
	frameTypes,
	'CAN FD frame type. The selection determines whether data_baud applies',
);

const busBitOrder = bitOrder(triggerOrders);
const TRIGGER_ON = 'line the data is matched on: MISO or MOSI for SPI, RX or TX for UART';
const spiTriggerOn = choice('trigger_on', spiLines, TRIGGER_ON);
const uartTriggerOn = choice('trigger_on', uartLines, TRIGGER_ON);
const dataPattern = (mnemonic: string): Param => ({
	...param(
		'data_pattern',
		mnemonic,
		spiPattern,
		'SPI data pattern with one entry per bit. Use 0, 1 or X for either. The array length must match data_length. The command has no query form',
	),
	wire: (value) => (value as string[]).join(','),
});

const address = counted('address', iicAddress, 'IIC address the trigger matches, 0 to 127');
const addressLength = choice('address_length', addressLengths, 'length of the IIC address: 7BIT or 10BIT');
const direction = choice(
	'direction',
	directions,
	'IIC frame direction. Applies to 7-bit and 10-bit address conditions',
);

const checksumError = switched(
	'checksum_error',
	'whether the LIN error trigger takes a checksum error, which is what lin_standard, error_id and data_length describe',
);
const parityError = switched('parity_error', 'whether the LIN error trigger takes a header parity error');
const syncError = switched('sync_error', 'whether the LIN error trigger takes a sync byte error');
const linStandard = counted(
	'lin_standard',
	revisions,
	'LIN protocol revision used for the checksum. Zero is revision 1.3 and one is revision 2.x',
);
const errorIdentifier = counted('error_id', linErrorIds, 'identifier of the LIN error frame, 0 to 63');

const frameCycle = counted('frame_cycle', cycles, 'FlexRay frame cycle, 0 to 63');
const repetition = counted('repetition', repetitions, 'FlexRay cycle repetition. Applies to Equal cycle comparison');

const audioChannel = choice('audio_channel', sides, 'IIS channel the trigger takes: LEFT or RIGHT');
const audioValue = counted(
	'value',
	audioValues,
	'IIS data value to compare. The range follows data_length. The maximum schema value means any value',
);

// One trigger type is one row: its parameters in the order they are sent, which is the order the guide constrains
// them in. The source first, because every level is measured against its scale and offset; then what the type
// selects on; then the levels; then the limit range, which decides whether its two time bounds mean anything; then
// coupling and noise rejection; then the holdoff values before the holdoff kind that picks one of them.
const types: Record<string, Param[]> = {
	EDGE: [
		anySource(':TRIGger:EDGE:SOURce'),
		impedance(':TRIGger:EDGE:IMPedance'),
		alternatingSlope(':TRIGger:EDGE:SLOPe'),
		level(':TRIGger:EDGE:LEVel'),
		coupling(':TRIGger:EDGE:COUPling'),
		noiseReject(':TRIGger:EDGE:NREJect'),
		holdoffEvents(':TRIGger:EDGE:HLDEVent'),
		holdoffTime(':TRIGger:EDGE:HLDTime'),
		holdoff(':TRIGger:EDGE:HOLDoff'),
		holdoffStart(':TRIGger:EDGE:HSTart'),
	],
	SLOPe: [
		analogSource(':TRIGger:SLOPe:SOURce'),
		alternatingSlope(':TRIGger:SLOPe:SLOPe'),
		levelHigh(':TRIGger:SLOPe:HLEVel'),
		levelLow(':TRIGger:SLOPe:LLEVel'),
		limit(':TRIGger:SLOPe:LIMit'),
		timeLower(':TRIGger:SLOPe:TLOWer'),
		timeUpper(':TRIGger:SLOPe:TUPPer'),
		coupling(':TRIGger:SLOPe:COUPling'),
		noiseReject(':TRIGger:SLOPe:NREJect'),
		holdoffEvents(':TRIGger:SLOPe:HLDEVent'),
		holdoffTime(':TRIGger:SLOPe:HLDTime'),
		holdoff(':TRIGger:SLOPe:HOLDoff'),
		holdoffStart(':TRIGger:SLOPe:HSTart'),
	],
	PULSE: [
		mixedSource(':TRIGger:PULSe:SOURce'),
		polarity(':TRIGger:PULSe:POLarity'),
		level(':TRIGger:PULSe:LEVel'),
		limit(':TRIGger:PULSe:LIMit'),
		timeLower(':TRIGger:PULSe:TLOWer'),
		timeUpper(':TRIGger:PULSe:TUPPer'),
		coupling(':TRIGger:PULSe:COUPling'),
		noiseReject(':TRIGger:PULSe:NREJect'),
		holdoffEvents(':TRIGger:PULSe:HLDEVent'),
		holdoffTime(':TRIGger:PULSe:HLDTime'),
		holdoff(':TRIGger:PULSe:HOLDoff'),
		holdoffStart(':TRIGger:PULSe:HSTart'),
	],
	INTerval: [
		mixedSource(':TRIGger:INTerval:SOURce'),
		directedSlope(':TRIGger:INTerval:SLOPe'),
		level(':TRIGger:INTerval:LEVel'),
		limit(':TRIGger:INTerval:LIMit'),
		timeLower(':TRIGger:INTerval:TLOWer'),
		timeUpper(':TRIGger:INTerval:TUPPer'),
		coupling(':TRIGger:INTerval:COUPling'),
		noiseReject(':TRIGger:INTerval:NREJect'),
		holdoffEvents(':TRIGger:INTerval:HLDEVent'),
		holdoffTime(':TRIGger:INTerval:HLDTime'),
		holdoff(':TRIGger:INTerval:HOLDoff'),
		holdoffStart(':TRIGger:INTerval:HSTart'),
	],
	WINDow: [
		analogSource(':TRIGger:WINDow:SOURce'),
		windowType(':TRIGger:WINDow:TYPE'),
		levelHigh(':TRIGger:WINDow:HLEVel'),
		levelLow(':TRIGger:WINDow:LLEVel'),
		centerLevel(':TRIGger:WINDow:CLEVel'),
		deltaLevel(':TRIGger:WINDow:DLEVel'),
		coupling(':TRIGger:WINDow:COUPling'),
		noiseReject(':TRIGger:WINDow:NREJect'),
		holdoffEvents(':TRIGger:WINDow:HLDEVent'),
		holdoffTime(':TRIGger:WINDow:HLDTime'),
		holdoff(':TRIGger:WINDow:HOLDoff'),
		holdoffStart(':TRIGger:WINDow:HSTart'),
	],
	DROPout: [
		mixedSource(':TRIGger:DROPout:SOURce'),
		overtime(':TRIGger:DROPout:TYPE'),
		directedSlope(':TRIGger:DROPout:SLOPe'),
		level(':TRIGger:DROPout:LEVel'),
		dropoutTime(':TRIGger:DROPout:TIME'),
		coupling(':TRIGger:DROPout:COUPling'),
		noiseReject(':TRIGger:DROPout:NREJect'),
		holdoffEvents(':TRIGger:DROPout:HLDEVent'),
		holdoffTime(':TRIGger:DROPout:HLDTime'),
		holdoff(':TRIGger:DROPout:HOLDoff'),
		holdoffStart(':TRIGger:DROPout:HSTart'),
	],
	RUNT: [
		analogSource(':TRIGger:RUNT:SOURce'),
		polarity(':TRIGger:RUNT:POLarity'),
		levelHigh(':TRIGger:RUNT:HLEVel'),
		levelLow(':TRIGger:RUNT:LLEVel'),
		limit(':TRIGger:RUNT:LIMit'),
		timeLower(':TRIGger:RUNT:TLOWer'),
		timeUpper(':TRIGger:RUNT:TUPPer'),
		coupling(':TRIGger:RUNT:COUPling'),
		noiseReject(':TRIGger:RUNT:NREJect'),
		holdoffEvents(':TRIGger:RUNT:HLDEVent'),
		holdoffTime(':TRIGger:RUNT:HLDTime'),
		holdoff(':TRIGger:RUNT:HOLDoff'),
		holdoffStart(':TRIGger:RUNT:HSTart'),
	],
	VIDeo: [
		analogSource(':TRIGger:VIDeo:SOURce'),
		videoStandard(':TRIGger:VIDeo:STANdard'),
		frameRate(':TRIGger:VIDeo:FRATe'),
		lineCount(':TRIGger:VIDeo:LCNT'),
		fieldCount(':TRIGger:VIDeo:FCNT'),
		interlace(':TRIGger:VIDeo:INTerlace'),
		level(':TRIGger:VIDeo:LEVel'),
		sync(':TRIGger:VIDeo:SYNC'),
		field(':TRIGger:VIDeo:FIELd'),
		line(':TRIGger:VIDeo:LINE'),
	],
	PATTern: [
		pattern(':TRIGger:PATTern:INPut'),
		channelLevel(':TRIGger:PATTern:LEVel'),
		combination(':TRIGger:PATTern:LOGic'),
		limit(':TRIGger:PATTern:LIMit'),
		timeLower(':TRIGger:PATTern:TLOWer'),
		timeUpper(':TRIGger:PATTern:TUPPer'),
		holdoffEvents(':TRIGger:PATTern:HLDEVent'),
		holdoffTime(':TRIGger:PATTern:HLDTime'),
		holdoff(':TRIGger:PATTern:HOLDoff'),
		holdoffStart(':TRIGger:PATTern:HSTart'),
	],
	QUALified: [
		edgeSource(':TRIGger:QUALified:ESource'),
		edgeLevel(':TRIGger:QUALified:ELEVel'),
		edgeSlope(':TRIGger:QUALified:ESLope'),
		qualifySource(':TRIGger:QUALified:QSource'),
		qualifyLevel(':TRIGger:QUALified:QLEVel'),
		qualifiedState(':TRIGger:QUALified:TYPE'),
		limit(':TRIGger:QUALified:LIMit'),
		timeLower(':TRIGger:QUALified:TLOWer'),
		timeUpper(':TRIGger:QUALified:TUPPer'),
	],
	DELay: [
		pattern(':TRIGger:DELay:SOURce'),
		channelLevel(':TRIGger:DELay:LEVel'),
		directedSlope(':TRIGger:DELay:SLOPe'),
		source2(':TRIGger:DELay:SOURce2'),
		level2(':TRIGger:DELay:LEVel2'),
		slope2(':TRIGger:DELay:SLOPe2'),
		limit(':TRIGger:DELay:LIMit'),
		timeLower(':TRIGger:DELay:TLOWer'),
		timeUpper(':TRIGger:DELay:TUPPer'),
		coupling(':TRIGger:DELay:COUPling'),
	],
	NEDGe: [
		mixedSource(':TRIGger:NEDGe:SOURce'),
		directedSlope(':TRIGger:NEDGe:SLOPe'),
		level(':TRIGger:NEDGe:LEVel'),
		idleTime(':TRIGger:NEDGe:IDLE'),
		edgeCount(':TRIGger:NEDGe:EDGE'),
		noiseReject(':TRIGger:NEDGe:NREJect'),
		holdoffEvents(':TRIGger:NEDGe:HLDEVent'),
		holdoffTime(':TRIGger:NEDGe:HLDTime'),
		holdoff(':TRIGger:NEDGe:HOLDoff'),
		holdoffStart(':TRIGger:NEDGe:HSTart'),
	],
	SHOLd: [
		clockSource(':TRIGger:SHOLd:CSource'),
		clockThreshold(':TRIGger:SHOLd:CTHReshold'),
		directedSlope(':TRIGger:SHOLd:SLOPe'),
		dataSource(':TRIGger:SHOLd:DSource'),
		dataThreshold(':TRIGger:SHOLd:DTHReshold'),
		dataState(':TRIGger:SHOLd:LEVel'),
		setupHold(':TRIGger:SHOLd:TYPE'),
		limit(':TRIGger:SHOLd:LIMit'),
		timeLower(':TRIGger:SHOLd:TLOWer'),
		timeUpper(':TRIGger:SHOLd:TUPPer'),
	],
	IIC: [
		clockSource(':TRIGger:IIC:SCLSource'),
		clockThreshold(':TRIGger:IIC:SCLThreshold'),
		dataSource(':TRIGger:IIC:SDASource'),
		dataThreshold(':TRIGger:IIC:SDAThreshold'),
		addressLength(':TRIGger:IIC:ALENgth'),
		iicDataLength(':TRIGger:IIC:DLENgth'),
		iicCondition(':TRIGger:IIC:CONDition'),
		address(':TRIGger:IIC:ADDRess'),
		direction(':TRIGger:IIC:RWBit'),
		comparison(':TRIGger:IIC:LIMit'),
		data(':TRIGger:IIC:DATA'),
		data2(':TRIGger:IIC:DAT2'),
	],
	SPI: [
		clockSource(':TRIGger:SPI:CLKSource'),
		clockThreshold(':TRIGger:SPI:CLKThreshold'),
		mosiSource(':TRIGger:SPI:MOSISource'),
		mosiThreshold(':TRIGger:SPI:MOSIThreshold'),
		misoSource(':TRIGger:SPI:MISOSource'),
		misoThreshold(':TRIGger:SPI:MISOThreshold'),
		csSource(':TRIGger:SPI:CSSource'),
		csThreshold(':TRIGger:SPI:CSThreshold'),
		ncsSource(':TRIGger:SPI:NCSSource'),
		ncsThreshold(':TRIGger:SPI:NCSThreshold'),
		csType(':TRIGger:SPI:CSTYpe'),
		latchEdge(':TRIGger:SPI:LATChedge'),
		busBitOrder(':TRIGger:SPI:BITorder'),
		spiTriggerOn(':TRIGger:SPI:TTYPe'),
		spiDataLength(':TRIGger:SPI:DLENgth'),
		dataPattern(':TRIGger:SPI:DATA'),
	],
	UART: [
		rxSource(':TRIGger:UART:RXSource'),
		rxThreshold(':TRIGger:UART:RXThreshold'),
		txSource(':TRIGger:UART:TXSource'),
		txThreshold(':TRIGger:UART:TXThreshold'),
		uartBaud(':TRIGger:UART:BAUD'),
		busBitOrder(':TRIGger:UART:BITorder'),
		parity(':TRIGger:UART:PARity'),
		stopBitCount(':TRIGger:UART:STOP'),
		idleLevel(':TRIGger:UART:IDLE'),
		uartDataLength(':TRIGger:UART:DLENgth'),
		uartTriggerOn(':TRIGger:UART:TTYPe'),
		uartCondition(':TRIGger:UART:CONDition'),
		comparison(':TRIGger:UART:LIMit'),
		data(':TRIGger:UART:DATA'),
	],
	CAN: [
		mixedSource(':TRIGger:CAN:SOURce'),
		threshold(':TRIGger:CAN:THReshold'),
		canBaud(':TRIGger:CAN:BAUD'),
		idLength(':TRIGger:CAN:IDLength'),
		canCondition(':TRIGger:CAN:CONDition'),
		canIdentifier(':TRIGger:CAN:ID'),
		data(':TRIGger:CAN:DATA'),
		data2(':TRIGger:CAN:DAT2'),
	],
	CANFd: [
		mixedSource(':TRIGger:CANFd:SOURce'),
		threshold(':TRIGger:CANFd:THReshold'),
		canfdBaud(':TRIGger:CANFd:BAUDNominal'),
		canfdDataBaud(CANFD_DATA_BAUD)(':TRIGger:CANFd:BAUDData'),
		frameType(':TRIGger:CANFd:FTYPe'),
		idLength(':TRIGger:CANFd:IDLength'),
		canCondition(':TRIGger:CANFd:CONDition'),
		canIdentifier(':TRIGger:CANFd:ID'),
		data(':TRIGger:CANFd:DATA'),
		data2(':TRIGger:CANFd:DAT2'),
	],
	LIN: [
		mixedSource(':TRIGger:LIN:SOURce'),
		threshold(':TRIGger:LIN:THReshold'),
		linBaud(':TRIGger:LIN:BAUD'),
		linCondition(':TRIGger:LIN:CONDition'),
		linIdentifier(':TRIGger:LIN:ID'),
		data(':TRIGger:LIN:DATA'),
		data2(':TRIGger:LIN:DAT2'),
		checksumError(':TRIGger:LIN:ERRor:CHECksum'),
		parityError(':TRIGger:LIN:ERRor:PARity'),
		syncError(':TRIGger:LIN:ERRor:SYNC'),
		linStandard(':TRIGger:LIN:STANdard'),
		errorIdentifier(':TRIGger:LIN:ERRor:ID'),
		linDataLength(':TRIGger:LIN:ERRor:DLENgth'),
	],
	FLEXray: [
		mixedSource(':TRIGger:FLEXray:SOURce'),
		threshold(':TRIGger:FLEXray:THReshold'),
		flexBaud(':TRIGger:FLEXray:BAUD'),
		flexCondition(':TRIGger:FLEXray:CONDition'),
		flexIdentifier(':TRIGger:FLEXray:FRAMe:ID'),
		cycleComparison(':TRIGger:FLEXray:FRAMe:COMPare'),
		frameCycle(':TRIGger:FLEXray:FRAMe:CYCLe'),
		repetition(':TRIGger:FLEXray:FRAMe:REPetition'),
	],
	IIS: [
		clockSource(':TRIGger:IIS:BCLKSource'),
		clockThreshold(':TRIGger:IIS:BCLKThreshold'),
		wsSource(':TRIGger:IIS:WSSource'),
		wsThreshold(':TRIGger:IIS:WSTHreshold'),
		dataSource(':TRIGger:IIS:DSource'),
		dataThreshold(':TRIGger:IIS:DTHReshold'),
		audioVariant(triggerVariants)(':TRIGger:IIS:AVARiant'),
		latchEdge(':TRIGger:IIS:BCLK:EDGE'),
		busBitOrder(':TRIGger:IIS:BITorder'),
		leftLevel(':TRIGger:IIS:LCH'),
		audioChannel(':TRIGger:IIS:CHANnel'),
		iisDataLength(':TRIGger:IIS:DLENgth'),
		iisCondition(':TRIGger:IIS:CONDition'),
		comparison(':TRIGger:IIS:COMPare'),
		audioValue(':TRIGger:IIS:VALue'),
	],
	SENT: [mixedSource(':TRIGger:SENT:SOURce'), threshold(':TRIGger:SENT:THReshold')],
	M1553: [],
	ARINC429: [],
};

// The guide marks the FlexRay, CAN FD, IIS and SENT subsystems [Option] (pp. 644, 653, 664, 680) and gives M1553
// and ARINC429 no parameter command at all, so for those two selecting the type is everything this driver can do.
const optional: readonly string[] = ['FLEXray', 'CANFd', 'IIS', 'SENT', 'M1553', 'ARINC429'];

// Four video parameters belong to the custom standard alone (pp. 460-464), which gates both what may be sent beside
// a standard and what get_trigger asks for once it has read one. The line and the field are not gated: p. 466 gives
// the line to every standard but the custom one while the p. 464 table gives the custom one a trigger line and a
// trigger field of its own, so the scope decides.
const custom: readonly string[] = ['frame_rate', 'line_count', 'field_count', 'interlace'];

const names = Object.keys(types) as [string, ...string[]];

const triggerType = param(
	'type',
	TYPE,
	z.enum(names),
	'Trigger type. The selected type determines which parameters apply',
	(raw) => asState(raw, names),
);

const modeRow = param(
	'mode',
	MODE,
	z.enum(modes),
	'Sweep mode. Auto triggers when no condition is met, Normal waits for one, Single stops after the first and Force Trigger captures one frame immediately',
	(raw) => asState(raw, modes),
);

function check(input: Values, ctx: z.RefinementCtx): void {
	selected(types[String(input.type)] ?? [], `trigger type ${input.type}`, input, ctx, 'type');
	bounds(input, ctx);
	if (input.impedance !== undefined && input.source !== undefined && !String(input.source).startsWith('EX')) {
		ctx.addIssue({
			code: 'custom',
			message: 'impedance requires an EX or EX5 source. Remove it or choose an external source',
			path: ['impedance'],
		});
	}
	if (input.standard !== undefined && input.standard !== 'CUSTom') {
		for (const name of custom.filter((name) => input[name] !== undefined)) {
			ctx.addIssue({
				code: 'custom',
				message: `${name} requires the Custom video standard. Remove it or select Custom`,
				path: [name],
			});
		}
	}
	if (Array.isArray(input.data_pattern) && input.data_length !== input.data_pattern.length) {
		const message = 'data_pattern requires one entry per bit. Set data_length to the array length';
		ctx.addIssue({ code: 'custom', message, path: ['data_pattern'] });
	}
	if (input.id_length === '11BITS' && typeof input.id === 'number' && input.id > 2048) {
		const message = 'An 11-bit identifier accepts 0 to 2048. Reduce id or select a 29-bit identifier';
		ctx.addIssue({ code: 'custom', message, path: ['id'] });
	}
	if (input.logic === 'OR' || input.logic === 'NAND') {
		for (const name of ['limit', 'time_lower', 'time_upper'].filter((name) => input[name] !== undefined)) {
			ctx.addIssue({
				code: 'custom',
				message: `${name} requires And or Nor logic. Remove it or choose a compatible logic`,
				path: [name],
			});
		}
	}
}

const gate = (scope: ScpiScope, input: Values): void => {
	const type = String(input.type);
	if (optional.includes(type)) {
		scope.warn(
			`The ${type} trigger requires an optional feature. Availability cannot be determined from model identity`,
		);
	}
	if (types[type]?.length === 0) {
		scope.warn(`The ${type} trigger exposes no configurable parameters. Only the trigger type was selected`);
	}
	gateSources(scope, input);
};

// get_trigger asks for a video parameter of the custom standard only once the standard it read says CUSTom, so a
// parameter the scope has no meaning for is left unread rather than queried.
async function read(session: ScpiSession, rows: readonly Param[]): Promise<Values> {
	const state: Values = {};
	for (const row of rows) {
		if (!row.parse || (custom.includes(row.name) && state.standard !== 'CUSTom')) continue;
		state[row.name] = row.parse(await session.query(`${row.mnemonic}?`));
	}
	return state;
}

// Run, stop and a forced frame each change what the scope has captured, so repeating one is not a no-op.
const acquiring = { ...mutating, idempotentHint: false };

export const triggerTools = [
	tool({
		name: 'get_trigger',
		description:
			'Read the trigger mode, status, frequency, type and parameters for the active trigger type. Pattern and Delay per-source levels are not read back. SPI data patterns have no query form and are not returned.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state: Values = {
					...(await readback(session, [modeRow])),
					status: asState(await session.query(`${STATUS}?`), statuses),
					frequency: asQuantity(await session.query(`${FREQUENCY}?`)),
					...(await readback(session, [triggerType])),
				};
				const rows = types[String(state.type)];
				if (!rows) {
					scope.warn(
						`The scope reports unsupported trigger type ${JSON.stringify(state.type)}. Only mode, status and frequency were read`,
					);
				}
				return { ...state, ...(rows ? await read(session, rows) : {}) };
			}),
	}),
	tool({
		name: 'configure_trigger',
		description:
			'Select a trigger type, set its parameters and read back the requested values. Each parameter must be supported by the selected type. Levels and time values adjusted by the scope are returned with a warning. Pattern and Delay channel levels and SPI data patterns are written but not read back. Optional trigger features return an availability warning. Use configure_trigger_mode to set the sweep mode or run and stop acquisition.',
		input: z
			.strictObject({
				type: z.enum(names).describe(triggerType.description),
				...shape(Object.values(types).flat()),
			})
			.superRefine(check),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const rows = types[String(input.type)] ?? [];
			const commands = plan(...settings([triggerType], input), ...settings(rows, input));
			return scope.execute(async (session) => {
				gate(scope, input);
				for (const command of commands) await session.command(command);
				const state = await readback(session, [triggerType, ...applied(rows, input)]);
				compare(
					scope,
					[triggerType, ...rows],
					input,
					state,
					'a level or a time the source and the model cannot take is moved to the nearest one they can',
				);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'configure_trigger_mode',
		description:
			'Set the trigger sweep mode and optionally run or stop acquisition, then read the resulting mode and status. Auto triggers when no condition is met, Normal waits for one, Single stops after the first and Force Trigger captures one frame immediately. Run and stop have no query form. Force Trigger read-back is not verified on hardware.',
		input: z.strictObject({
			...inputs([modeRow]),
			action: z.enum(['run', 'stop']).optional().describe('Run or stop acquisition after applying the mode'),
		}),
		annotations: acquiring,
		handler: (input: Values, scope) => {
			const action = input.action as 'run' | 'stop' | undefined;
			const commands = plan(...settings([modeRow], input), action && (action === 'run' ? RUN : STOP));
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state = {
					...(await readback(session, applied([modeRow], input))),
					status: asState(await session.query(`${STATUS}?`), statuses),
				};
				compare(scope, [modeRow], input, state);
				return { commands, state };
			});
		},
	}),
];
