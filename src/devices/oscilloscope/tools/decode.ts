import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { parseState } from '../../../scpi/values.ts';
import { flag, inputs, type Param, pairs, param, type Values } from '../../../tools/params.ts';
import { type Channel, channels, type Scope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { digitals, withUnit } from './schema.ts';

export const bus = z.enum(['B1', 'B2']).describe('Decode bus');

export const decodeSource = z
	.enum([...channels, ...digitals])
	.describe('Analog channel C1-C4 or digital channel D0-D15 (MSO option)');

export type DecodeSource = z.output<typeof decodeSource>;

export const threshold = withUnit(['', 'V'], "Threshold in volts, for example '0.2V' or '0.2'. Only V is supported.");

const isAnalog = (source: DecodeSource): source is Channel => source.startsWith('C');

export const thresholdMatchesSource = (source?: DecodeSource, level?: string): boolean =>
	source === undefined || isAnalog(source) === (level !== undefined);

export const thresholdIssue = (name: string) => ({
	message: `An analog ${name.toUpperCase()} source requires ${name}_threshold. Remove the threshold when using a digital source.`,
	path: [`${name}_threshold`],
});

// Decode (pp. 59-71) and serial trigger (pp. 208-261) are SDS1000X-E features addressed at the same sources.
export function requireProtocol(scope: Scope, ...sources: Array<DecodeSource | undefined>): void {
	scope.require('xe');
	for (const source of sources) {
		if (source === undefined) continue;
		if (isAnalog(source)) scope.requireChannel(source);
		else scope.requireSupport('mso_xe');
	}
}

const readDecode = async (session: ScpiSession) => {
	const raw = await session.query('DCST?');
	return { enabled: parseState(raw, ['OFF', 'ON']) === 'ON', raw };
};

const writeOnly = ['DCPA', 'B<n>:DCIC', 'B<n>:DCSP', 'B<n>:DCUT', 'B<n>:DCCN', 'B<n>:DCLN'];

const line = z.number().int().min(1).max(7);
const chipSelect = z.enum(['CS', 'NCS', 'TIMEOUT']);
const selector = { CS: 'cs', NCS: 'ncs', TIMEOUT: 'timeout' } as const;
type Selector = keyof typeof selector;
const baud = (min: number, max: number) => z.number().int().min(min).max(max);
const bitOrder = z.enum(['MSB', 'LSB']);

const timeoutValue = withUnit(
	['', 'S', 'MS', 'US', 'NS', 'PS'],
	"Time, for example '2US' or '0.000002'. Model support for subsecond unit suffixes is uncertain.",
);

const source = (name: string, mnemonic: string, what: string): Param[] => [
	param(name, mnemonic, decodeSource, `${what} source`),
	param(`${name}_threshold`, `${mnemonic}T`, threshold, `${what} threshold, required for an analog ${mnemonic} source`),
];

const sourceNames = (params: readonly Param[]) => params.filter((p) => p.schema === decodeSource).map((p) => p.name);

const busInput = (params: readonly Param[]) =>
	sourceNames(params).reduce(
		(schema, name) =>
			schema.refine(
				(input: Values) => thresholdMatchesSource(input[name] as DecodeSource, input[`${name}_threshold`] as string),
				thresholdIssue(name),
			),
		z.object({ bus, ...inputs(params) }),
	);

// B<n>:DCIC and its four siblings are wholly command-only (pp. 61-71): there is no state to read back at all.
const configureBus = (scope: Scope, params: readonly Param[], mnemonic: string, input: Values) =>
	scope.execute(async (session) => {
		requireProtocol(scope, ...sourceNames(params).map((name) => input[name] as DecodeSource | undefined));
		const encoded = pairs(params, input);
		const commands = plan(encoded !== '' && `${input.bus}:${mnemonic} ${encoded}`);
		for (const command of commands) await session.command(command);
		return { commands, write_only: [`B<n>:${mnemonic}`] };
	});

const common = [
	param('bus', 'BUS', bus, 'bus the following decode settings apply to'),
	param('list', 'LIST', z.enum(['OFF', 'D1', 'D2']), 'OFF, or the decode list of bus 1 (D1) or bus 2 (D2)'),
	param('format', 'FOMT', z.enum(['BIN', 'DEC', 'HEX']), 'number format of the decoded data'),
	param(
		'copy',
		'LINK',
		z.enum(['TR_TO_DC', 'DC_TO_TR']),
		'TR_TO_DC copies the trigger setup into the decoder, DC_TO_TR copies the decoder into the trigger',
	),
	param('list_scroll', 'LSSC', line, 'list line to scroll to, 1 to the number of list lines'),
	param('list_lines', 'LSNM', line, 'number of list lines, 1 to 7'),
];

const i2c = [
	flag('display', 'DIS', 'show this bus'),
	...source('scl', 'SCL', 'clock'),
	...source('sda', 'SDA', 'data'),
	flag('read_write', 'RW', 'include the read/write bit in the address'),
];

const spi = [
	flag('display', 'DIS', 'show this bus'),
	...source('clk', 'CLK', 'clock'),
	param('edge', 'EDGE', z.enum(['RISING', 'FALLING']), 'clock edge the data is latched on'),
	...source('miso', 'MISO', 'master-in slave-out'),
	...source('mosi', 'MOSI', 'master-out slave-in'),
	param('chip_select_type', 'CSTP', chipSelect, 'chip selection by CS, by ~CS, or by clock timeout'),
	...source('cs', 'CS', 'active-high chip-select'),
	...source('ncs', 'NCS', 'active-low chip-select'),
	param('timeout', 'TIM', timeoutValue, 'clock timeout used by chip_select_type TIMEOUT'),
	param('bit_order', 'BIT', bitOrder, 'bit order of the decoded data'),
	param('data_length', 'DLEN', z.number().int().min(4).max(32), 'data length in bits, 4 to 32'),
];

const uart = [
	flag('display', 'DIS', 'show this bus'),
	...source('rx', 'RX', 'receive'),
	...source('tx', 'TX', 'transmit'),
	param('baud', 'BAUD', baud(300, 50_000_000), 'baud rate in bit/s without a unit, 300 to 50000000'),
	param('data_length', 'DLEN', z.number().int().min(5).max(8), 'data length in bits, 5 to 8'),
	param('parity', 'PAR', z.enum(['NONE', 'EVEN', 'ODD']), 'parity check'),
	param('stop_bits', 'STOP', z.literal([1, 1.5, 2]), 'length of the stop bit'),
	param('polarity', 'POL', z.enum(['LOW', 'HIGH']), 'idle level of the bus'),
	param('bit_order', 'BIT', bitOrder, 'bit order of the decoded data'),
];

const can = [
	flag('display', 'DIS', 'show this bus'),
	...source('canh', 'CANH', 'CANH'),
	...source('canl', 'CANL', 'CANL'),
	param('signal', 'SRC', z.enum(['CAN_H', 'CAN_L', 'SUB_L']), 'Signal to decode.'),
	param('baud', 'BAUD', baud(5000, 1_000_000), 'baud rate in bit/s without a unit, 5000 to 1000000'),
];

const LIN_BAUD_DOCUMENTED_MAX = 2000;

const lin = [
	flag('display', 'DIS', 'show this bus'),
	...source('src', 'SRC', 'LIN bus'),
	param(
		'baud',
		'BAUD',
		baud(300, 20_000),
		'Baud rate in bits per second without a unit, from 300 to 20000. Rates above 2000 are unverified.',
	),
];

export const decodeTools = [
	tool({
		name: 'get_decode',
		description:
			'Read whether serial decoding is enabled. Common and protocol-specific decode settings have no query form and cannot be read back.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				requireProtocol(scope);
				return { ...(await readDecode(session)), write_only: writeOnly };
			}),
	}),
	tool({
		name: 'configure_decode',
		description:
			'Enable serial decoding and configure the active bus, decode list, number format, copy direction between trigger and decoder, list position, and number of list lines. Decode is an SDS1000X-E feature. Common settings have no query form.',
		input: z
			.object({
				enabled: z.boolean().optional().describe('Turn serial decoding on or off.'),
				...inputs(common),
			})
			.refine(
				({ list_scroll, list_lines }: Values) =>
					list_scroll === undefined || (list_scroll as number) <= ((list_lines as number) ?? 7),
				{ message: 'list_scroll must not exceed list_lines', path: ['list_scroll'] },
			),
		annotations: mutating,
		handler: (input: Values, scope) =>
			scope.execute(async (session) => {
				requireProtocol(scope);
				const encoded = pairs(common, input);
				const enabled = input.enabled as boolean | undefined;
				const commands = plan(enabled !== undefined && `DCST ${onOff(enabled)}`, encoded !== '' && `DCPA ${encoded}`);
				if (input.list_scroll !== undefined && input.list_lines === undefined) {
					scope.warn(
						'Common decode settings have no query form. list_scroll was not checked against the current number of list lines.',
					);
				}
				for (const command of commands) await session.command(command);
				return { commands, state: await readDecode(session), write_only: ['DCPA'] };
			}),
	}),
	tool({
		name: 'configure_i2c_decode',
		description:
			'Configure the I2C decoder for bus B1 or B2, including visibility, clock and data sources, thresholds, and whether the read/write bit belongs to the address. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.',
		input: busInput(i2c),
		annotations: mutating,
		handler: (input, scope) => configureBus(scope, i2c, 'DCIC', input),
	}),
	tool({
		name: 'configure_spi_decode',
		description:
			'Configure the SPI decoder for bus B1 or B2, including visibility, clock and data sources, latch edge, chip selection, bit order, and data length. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.',
		input: busInput(spi).refine(
			(input: Values) =>
				input.chip_select_type === undefined || input[selector[input.chip_select_type as Selector]] !== undefined,
			{
				message: 'Provide cs for CS, ncs for NCS, or timeout for Timeout chip selection.',
				path: ['chip_select_type'],
			},
		),
		annotations: mutating,
		handler: (input, scope) => configureBus(scope, spi, 'DCSP', input),
	}),
	tool({
		name: 'configure_uart_decode',
		description:
			'Configure the UART decoder for bus B1 or B2, including visibility, receive and transmit sources, thresholds, baud rate, data length, parity, stop bits, idle level, and bit order. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.',
		input: busInput(uart),
		annotations: mutating,
		handler: (input, scope) => configureBus(scope, uart, 'DCUT', input),
	}),
	tool({
		name: 'configure_can_decode',
		description:
			'Configure the CAN decoder for bus B1 or B2, including visibility, CANH and CANL sources, thresholds, decoded signal, and baud rate. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.',
		input: busInput(can),
		annotations: mutating,
		handler: (input, scope) => configureBus(scope, can, 'DCCN', input),
	}),
	tool({
		name: 'configure_lin_decode',
		description:
			'Configure the LIN decoder for bus B1 or B2, including visibility, source, threshold, and baud rate. An analog source requires a threshold in volts. A digital source does not accept one. The command has no query form. Baud rates above 2000 are unverified.',
		input: busInput(lin),
		annotations: mutating,
		handler: async (input: Values, scope) => {
			const result = await configureBus(scope, lin, 'DCLN', input);
			const rate = input.baud as number | undefined;
			if (rate !== undefined && rate > LIN_BAUD_DOCUMENTED_MAX) {
				scope.warn(`LIN baud rate ${rate} is above ${LIN_BAUD_DOCUMENTED_MAX} and is unverified on hardware.`);
			}
			return result;
		},
	}),
];
