import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	assertUnknownWarning,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const replies = {
	'TRSE?': 'SERIAL',
	'TRIIC:SCL?': 'C1,1.65V',
	'TRIIC:SDA?': 'D0',
	'TRIIC:CON?': '7ADDA',
	'TRIIC:ADDR?': '41',
	'TRIIC:DATA?': '256',
	'TRIIC:DAT2?': '256',
	'TRIIC:QUAL?': 'EQUAL',
	'TRIIC:RW?': 'DONT_CARE',
	'TRIIC:ALEN?': '7BIT',
	'TRIIC:DLEN?': '8',
};

const queries = [
	'TRIIC:SCL?',
	'TRIIC:SDA?',
	'TRIIC:CON?',
	'TRIIC:ADDR?',
	'TRIIC:DATA?',
	'TRIIC:DAT2?',
	'TRIIC:QUAL?',
	'TRIIC:RW?',
	'TRIIC:ALEN?',
	'TRIIC:DLEN?',
];

// Every configure reads TRSE? first and reads back exactly the mnemonics it wrote, sources before parameters.
const echoOf = (rows: readonly string[], commands: readonly string[]) =>
	rows.filter((query) => commands.some((command) => `${command.split(' ')[0]}?` === query));

const wrote = (...commands: string[]) => ['TRSE?', ...commands, ...echoOf(queries, commands)];

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('I2C serial trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads every field, pairs the thresholds and hides the don\'t-care values behind "any"', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_i2c_trigger'));
		expect(state).toBeEqual({
			trigger_type: 'SERIAL',
			scl: 'C1',
			scl_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			sda: 'D0',
			condition: '7ADDA',
			address: 41,
			data: 'any',
			data2: 'any',
			qualifier: 'EQUAL',
			direction: 'DONT_CARE',
			address_length: '7BIT',
			data_length: 8,
		});
		assertSent(harness.fake, ['TRSE?', ...queries]);
		await assertReadOnly(harness.client, 'get_i2c_trigger');
	});

	it('reads the 10-bit don\'t-care address as "any" and reports a trigger type that is not SERIAL', async () => {
		harness.fake.replies.set('TRIIC:CON?', '10ADDA');
		harness.fake.replies.set('TRIIC:ADDR?', '1024');
		harness.fake.replies.set('TRSE?', 'EDGE,SR,C1,HT,OFF');
		try {
			const result = await call(harness, 'get_i2c_trigger');
			const state = payload(result);
			expect(state.address).toBe('any');
			expect(state.trigger_type).toBe('EDGE');
			expect((state.warnings as string[]).some((warning) => warning.includes('EDGE'))).toBeTruthy();
		} finally {
			harness.fake.replies.set('TRSE?', replies['TRSE?']);
			harness.fake.replies.set('TRIIC:CON?', replies['TRIIC:CON?']);
			harness.fake.replies.set('TRIIC:ADDR?', replies['TRIIC:ADDR?']);
		}
	});

	it('sends the guide SCL and SDA examples as one positional command each', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_i2c_trigger', { scl: 'C3', scl_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['TRIIC:SCL C3,0.2V']);
		assertSent(harness.fake, wrote('TRIIC:SCL C3,0.2V'));
		const both = payload(
			await call(harness, 'configure_i2c_trigger', {
				scl: 'C3',
				scl_threshold: '0.2V',
				sda: 'C3',
				sda_threshold: '0.2V',
			}),
		);
		expect(both.commands).toBeEqual(['TRIIC:SCL C3,0.2V', 'TRIIC:SDA C3,0.2V']);
	});

	it('sends a digital source without a threshold and reports the MSO option as unknown', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_i2c_trigger', { sda: 'D7' });
		expect(payload(result).commands).toBeEqual(['TRIIC:SDA D7']);
		assertUnknownWarning(result, 'mso_xe');
		assertSent(harness.fake, wrote('TRIIC:SDA D7'));
	});

	it('sends TRSE SERIAL before the protocol writes when both are requested in one operation', async () => {
		harness.fake.sent();
		await call(harness, 'configure_trigger_type', { type: 'SERIAL' });
		await call(harness, 'configure_i2c_trigger', { condition: 'START' });
		assertSent(harness.fake, ['TRSE SERIAL', 'TRSE?', ...wrote('TRIIC:CON START')]);
	});

	it('refuses to write while the scope triggers on another type, and warns when TRSE? is unreadable', async () => {
		harness.fake.replies.set('TRSE?', 'EDGE,SR,C1,HT,OFF');
		try {
			harness.fake.sent();
			const refused = await call(harness, 'configure_i2c_trigger', { condition: 'START' });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/current type is EDGE.*Select Serial/);
			assertSent(harness.fake, ['TRSE?']);
			harness.fake.replies.set('TRSE?', 'nonsense');
			const unchecked = payload(await call(harness, 'configure_i2c_trigger', { condition: 'START' }));
			expect(unchecked.commands).toBeEqual(['TRIIC:CON START']);
			expect(
				(unchecked.warnings as string[]).some((warning) => /trigger type response "nonsense".*unchecked/.test(warning)),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set('TRSE?', replies['TRSE?']);
		}
	});

	it('sends the guide address, data and data2 examples of a 10-bit address frame', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_i2c_trigger', {
				condition: '10ADDA',
				address: 290,
				data: 41,
				data2: 41,
				direction: 'WRITE',
			}),
		);
		expect(result.commands).toBeEqual([
			'TRIIC:CON 10ADDA',
			'TRIIC:ADDR 290',
			'TRIIC:DATA 41',
			'TRIIC:DAT2 41',
			'TRIIC:RW WRITE',
		]);
		assertSent(harness.fake, wrote(...(result.commands as string[])));
	});

	it("maps `any` to the don't-care value the address width and the data bytes give it", async () => {
		harness.fake.sent();
		const wide = payload(
			await call(harness, 'configure_i2c_trigger', { condition: '10ADDA', address: 'any', data: 'any' }),
		);
		expect(wide.commands).toBeEqual(['TRIIC:CON 10ADDA', 'TRIIC:ADDR 1024', 'TRIIC:DATA 256']);
		const narrow = payload(
			await call(harness, 'configure_i2c_trigger', { condition: '7ADDA', address: 'any', data2: 'any' }),
		);
		expect(narrow.commands).toBeEqual(['TRIIC:CON 7ADDA', 'TRIIC:ADDR 128', 'TRIIC:DAT2 256']);
	});

	it('takes the address width from TRIIC:CON? when the request does not carry the condition', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_i2c_trigger', { address: 'any', data: 12 }));
		expect(result.commands).toBeEqual(['TRIIC:ADDR 128', 'TRIIC:DATA 12']);
		assertSent(harness.fake, ['TRSE?', 'TRIIC:CON?', 'TRIIC:ADDR 128', 'TRIIC:DATA 12', 'TRIIC:ADDR?', 'TRIIC:DATA?']);
	});

	it('refuses a field the condition the scope holds does not use, writing nothing', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_i2c_trigger', { qualifier: 'MORE' });
		expect(result.isError).toBe(true);
		expect(String(payload(result).error)).toMatchRegex(/qualifier cannot be used with condition 7ADDA/);
		assertSent(harness.fake, ['TRSE?', 'TRIIC:CON?']);
	});

	it('sends the guide EEPROM and data-length examples', async () => {
		harness.fake.sent();
		const eeprom = payload(await call(harness, 'configure_i2c_trigger', { condition: 'EEPROM', qualifier: 'EQUAL' }));
		expect(eeprom.commands).toBeEqual(['TRIIC:CON EEPROM', 'TRIIC:QUAL EQUAL']);
		const length = payload(
			await call(harness, 'configure_i2c_trigger', {
				condition: 'DALENTH',
				address_length: '7BIT',
				data_length: 8,
			}),
		);
		expect(length.commands).toBeEqual(['TRIIC:CON DALENTH', 'TRIIC:ALEN 7BIT', 'TRIIC:DLEN 8']);
	});

	it('reports a threshold the scope did not take', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_i2c_trigger', { scl: 'C1', scl_threshold: '3V' });
		expect(
			(payload(result).warnings as string[]).some((warning) => /scl_threshold was set to "3V"/.test(warning)),
		).toBeTruthy();
	});

	it('rejects a request that cannot reach the wire, sending nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { scl: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { scl: 'D0', scl_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { sda_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { scl: 'C1', scl_threshold: '200MV' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'ADDRESS' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: '7ADDA', address: 128 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: '10ADDA', address: 1024 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: '7ADDA', qualifier: 'EQUAL' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'START', address: 1 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'EEPROM', data2: 1 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: '7ADDA', data_length: 4 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { data: 256 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { data2: -1 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'DALENTH', data_length: 0 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'DALENTH', data_length: 13 });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { condition: 'DALENTH', address_length: '8BIT' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_trigger', { direction: 'EITHER' });
	});
});

const spiReplies = {
	'TRSE?': 'SERIAL',
	'TRSPI:CLK?': 'C1,1.65V',
	'TRSPI:MOSI?': 'C2,1.65V',
	'TRSPI:MISO?': 'D0',
	'TRSPI:CS?': 'C3,200E-03V',
	'TRSPI:NCS?': 'D1',
	'TRSPI:CLK:EDGE?': 'RISING',
	'TRSPI:CLK:TIM?': '2.00E-06S',
	'TRSPI:CSTP?': 'CS',
	'TRSPI:TRTY?': 'MOSI',
	'TRSPI:DLEN?': '8',
	'TRSPI:BIT?': 'MSB',
};

const spiQueries = [
	'TRSPI:CLK?',
	'TRSPI:MOSI?',
	'TRSPI:MISO?',
	'TRSPI:CS?',
	'TRSPI:NCS?',
	'TRSPI:CLK:EDGE?',
	'TRSPI:CLK:TIM?',
	'TRSPI:CSTP?',
	'TRSPI:TRTY?',
	'TRSPI:DLEN?',
	'TRSPI:BIT?',
];

const wroteSpi = (...commands: string[]) => ['TRSE?', ...commands, ...echoOf(spiQueries, commands)];

describe('SPI serial trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(spiReplies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads every queryable field and reports the command-only pattern as write-only', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_spi_trigger'));
		expect(state).toBeEqual({
			trigger_type: 'SERIAL',
			clk: 'C1',
			clk_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			mosi: 'C2',
			mosi_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			miso: 'D0',
			cs: 'C3',
			cs_threshold: { value: 0.2, unit: 'V', raw: '200E-03V' },
			ncs: 'D1',
			edge: 'RISING',
			clock_timeout: { value: 2e-6, unit: 'S', raw: '2.00E-06S' },
			chip_select_type: 'CS',
			trigger_source: 'MOSI',
			data_length: 8,
			bit_order: 'MSB',
			write_only: ['TRSPI:DATA'],
		});
		assertSent(harness.fake, ['TRSE?', ...spiQueries]);
		await assertReadOnly(harness.client, 'get_spi_trigger');
	});

	it('sends the guide CLK, MOSI and MISO examples as one positional command each', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_spi_trigger', {
				clk: 'C3',
				clk_threshold: '0.2V',
				mosi: 'C3',
				mosi_threshold: '0.2V',
				miso: 'D7',
				edge: 'RISING',
			}),
		);
		expect(result.commands).toBeEqual([
			'TRSPI:CLK C3,0.2V',
			'TRSPI:CLK:EDGE RISING',
			'TRSPI:MOSI C3,0.2V',
			'TRSPI:MISO D7',
		]);
		assertSent(harness.fake, wroteSpi(...(result.commands as string[])));
	});

	// TRSPI:CSTP (p. 229) picks the chip-select source that means anything, so it has to reach the scope before
	// TRSPI:CS (p. 230) and TRSPI:NCS (p. 231), which is the one place a source does not travel first.
	it('sends every SPI command in the order PG01-E02C documents it', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_spi_trigger', {
				bit_order: 'MSB',
				data: '10X1',
				data_length: 4,
				trigger_source: 'MOSI',
				cs: 'C3',
				cs_threshold: '0.2V',
				chip_select_type: 'CS',
				miso: 'D7',
				mosi: 'C3',
				mosi_threshold: '0.2V',
				edge: 'RISING',
				clk: 'C3',
				clk_threshold: '0.2V',
			}),
		);
		const ordered = [
			'TRSPI:CLK C3,0.2V',
			'TRSPI:CLK:EDGE RISING',
			'TRSPI:MOSI C3,0.2V',
			'TRSPI:MISO D7',
			'TRSPI:CSTP CS',
			'TRSPI:CS C3,0.2V',
			'TRSPI:TRTY MOSI',
			'TRSPI:DLEN 4',
			'TRSPI:DATA 1,0,X,1',
			'TRSPI:BIT MSB',
		];
		expect(result.commands).toBeEqual(ordered);
		assertSent(harness.fake, wroteSpi(...ordered));

		const inverted = payload(await call(harness, 'configure_spi_trigger', { chip_select_type: 'NCS', ncs: 'D1' }));
		expect(inverted.commands).toBeEqual(['TRSPI:CSTP NCS', 'TRSPI:NCS D1']);
		assertSent(harness.fake, wroteSpi('TRSPI:CSTP NCS', 'TRSPI:NCS D1'));
	});

	it('pairs the chip-select type with the source or the timeout it triggers on', async () => {
		harness.fake.sent();
		const cs = payload(
			await call(harness, 'configure_spi_trigger', { chip_select_type: 'CS', cs: 'C3', cs_threshold: '0.2V' }),
		);
		expect(cs.commands).toBeEqual(['TRSPI:CSTP CS', 'TRSPI:CS C3,0.2V']);
		const timeout = payload(
			await call(harness, 'configure_spi_trigger', { chip_select_type: 'TIMEOUT', clock_timeout: '2US' }),
		);
		expect(timeout.commands).toBeEqual(['TRSPI:CLK:TIM 2US', 'TRSPI:CSTP TIMEOUT']);
		assertSent(harness.fake, [
			...wroteSpi(...(cs.commands as string[])),
			...wroteSpi(...(timeout.commands as string[])),
		]);
	});

	it('takes the chip-select type from TRSPI:CSTP? when the request does not carry it', async () => {
		harness.fake.sent();
		const refused = await call(harness, 'configure_spi_trigger', { clock_timeout: '2US' });
		expect(refused.isError).toBe(true);
		expect(String(payload(refused).error)).toMatchRegex(/clock_timeout cannot be used with chip_select_type CS/);
		assertSent(harness.fake, ['TRSE?', 'TRSPI:CSTP?']);
		harness.fake.replies.set('TRSPI:CSTP?', 'TIMEOUT');
		try {
			const result = payload(await call(harness, 'configure_spi_trigger', { clock_timeout: '2US' }));
			expect(result.commands).toBeEqual(['TRSPI:CLK:TIM 2US']);
			assertSent(harness.fake, ['TRSE?', 'TRSPI:CSTP?', 'TRSPI:CLK:TIM 2US', 'TRSPI:CLK:TIM?']);
		} finally {
			harness.fake.replies.set('TRSPI:CSTP?', spiReplies['TRSPI:CSTP?']);
		}
	});

	it('sends the length before the pattern and echoes the pattern it sent', async () => {
		harness.fake.sent();
		const string = payload(await call(harness, 'configure_spi_trigger', { data: '10X1', data_length: 4 }));
		expect(string.commands).toBeEqual(['TRSPI:DLEN 4', 'TRSPI:DATA 1,0,X,1']);
		const array = payload(
			await call(harness, 'configure_spi_trigger', { data: ['X', 'X', 'X', 'X'], data_length: 4, bit_order: 'LSB' }),
		);
		expect(array.commands).toBeEqual(['TRSPI:DLEN 4', 'TRSPI:DATA X,X,X,X', 'TRSPI:BIT LSB']);
		assertSent(harness.fake, [
			...wroteSpi(...(string.commands as string[])),
			...wroteSpi(...(array.commands as string[])),
		]);
	});

	it('reports a data length the scope did not take', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_spi_trigger', { data: '1'.repeat(16), data_length: 16 });
		expect(
			(payload(result).warnings as string[]).some((warning) => /data_length was set to 16/.test(warning)),
		).toBeTruthy();
	});

	it('rejects a request that cannot reach the wire, sending nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { clk: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { clk: 'D0', clk_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { ncs_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { chip_select_type: 'CS' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { chip_select_type: 'NCS', cs: 'D0' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', {
			chip_select_type: 'TIMEOUT',
			clock_timeout: '50NS',
		});
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', {
			chip_select_type: 'TIMEOUT',
			clock_timeout: '10MS',
		});
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { data: '10X1' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { data: '10X1', data_length: 8 });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { data: '10X', data_length: 3 });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { data: ['1', '0', '2', '1'], data_length: 4 });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { data_length: 97 });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { edge: 'BOTH' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { trigger_source: 'SCK' });
		await assertInvalidSendsNothing(harness, 'configure_spi_trigger', { bit_order: 'MSB0' });
	});
});

const uartReplies = {
	'TRSE?': 'SERIAL',
	'TRUART:RX?': 'C1,1.65V',
	'TRUART:TX?': 'D0',
	'TRUART:TRTY?': 'RX',
	'TRUART:CON?': 'DATA',
	'TRUART:QUAL?': 'EQUAL',
	'TRUART:DATA?': '256',
	'TRUART:BAUD?': 'CUSTOM,2000',
	'TRUART:DLEN?': '8',
	'TRUART:PAR?': 'NONE',
	'TRUART:POL?': 'HIGH',
	'TRUART:STOP?': '1',
	'TRUART:BIT?': 'LSB',
};

const uartQueries = [
	'TRUART:RX?',
	'TRUART:TX?',
	'TRUART:TRTY?',
	'TRUART:CON?',
	'TRUART:QUAL?',
	'TRUART:DATA?',
	'TRUART:BAUD?',
	'TRUART:DLEN?',
	'TRUART:PAR?',
	'TRUART:POL?',
	'TRUART:STOP?',
	'TRUART:BIT?',
];

const wroteUart = (...commands: string[]) => ['TRSE?', ...commands, ...echoOf(uartQueries, commands)];

describe('UART serial trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(uartReplies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads every field, hides the don\'t-care byte behind "any" and reports a custom baud rate as the rate', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_uart_trigger'));
		expect(state).toBeEqual({
			trigger_type: 'SERIAL',
			rx: 'C1',
			rx_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			tx: 'D0',
			trigger_source: 'RX',
			condition: 'DATA',
			qualifier: 'EQUAL',
			data: 'any',
			baud: 2000,
			data_length: 8,
			parity: 'NONE',
			polarity: 'HIGH',
			stop_bits: 1,
			bit_order: 'LSB',
		});
		assertSent(harness.fake, ['TRSE?', ...uartQueries]);
		await assertReadOnly(harness.client, 'get_uart_trigger');
	});

	it('sends the guide RX and TX examples as one positional command each', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_uart_trigger', {
				rx: 'C3',
				rx_threshold: '0.2V',
				tx: 'C3',
				tx_threshold: '0.2V',
				trigger_source: 'TX',
			}),
		);
		expect(result.commands).toBeEqual(['TRUART:RX C3,0.2V', 'TRUART:TX C3,0.2V', 'TRUART:TRTY TX']);
		assertSent(harness.fake, wroteUart(...(result.commands as string[])));
	});

	it('sends the framing settings in the order of the guide', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_uart_trigger', {
				bit_order: 'MSB',
				stop_bits: 1.5,
				polarity: 'LOW',
				parity: 'ODD',
				data_length: 6,
			}),
		);
		expect(result.commands).toBeEqual([
			'TRUART:DLEN 6',
			'TRUART:PAR ODD',
			'TRUART:POL LOW',
			'TRUART:STOP 1.5',
			'TRUART:BIT MSB',
		]);
		assertSent(harness.fake, wroteUart(...(result.commands as string[])));
	});

	it("takes a data byte and its qualifier with condition DATA, and `any` for the guide don't-care 256", async () => {
		harness.fake.sent();
		const byte = payload(
			await call(harness, 'configure_uart_trigger', { condition: 'DATA', qualifier: 'EQUAL', data: 41 }),
		);
		expect(byte.commands).toBeEqual(['TRUART:CON DATA', 'TRUART:QUAL EQUAL', 'TRUART:DATA 41']);
		const ignored = payload(
			await call(harness, 'configure_uart_trigger', { condition: 'DATA', qualifier: 'MORE', data: 'any' }),
		);
		expect(ignored.commands).toBeEqual(['TRUART:CON DATA', 'TRUART:QUAL MORE', 'TRUART:DATA 256']);
		assertSent(harness.fake, [
			...wroteUart(...(byte.commands as string[])),
			...wroteUart(...(ignored.commands as string[])),
		]);
	});

	it('sends a standard baud rate on its own and every other rate as CUSTOM', async () => {
		harness.fake.sent();
		const custom = payload(await call(harness, 'configure_uart_trigger', { baud: 2000 }));
		expect(custom.commands).toBeEqual(['TRUART:BAUD CUSTOM,2000']);
		expect(custom.warnings).toBe(undefined);
		expect((custom.state as Record<string, unknown>).baud).toBeEqual(2000);
		assertSent(harness.fake, wroteUart('TRUART:BAUD CUSTOM,2000'));
		harness.fake.replies.set('TRUART:BAUD?', '9600');
		try {
			const standard = payload(await call(harness, 'configure_uart_trigger', { baud: 9600 }));
			expect(standard.commands).toBeEqual(['TRUART:BAUD 9600']);
			expect(standard.warnings).toBe(undefined);
			expect((standard.state as Record<string, unknown>).baud).toBeEqual(9600);
		} finally {
			harness.fake.replies.set('TRUART:BAUD?', uartReplies['TRUART:BAUD?']);
		}
	});

	it('checks a data field sent without the condition against TRUART:CON?', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_uart_trigger', { data: 12 }));
		expect(result.commands).toBeEqual(['TRUART:DATA 12']);
		assertSent(harness.fake, ['TRSE?', 'TRUART:CON?', 'TRUART:DATA 12', 'TRUART:DATA?']);
		harness.fake.replies.set('TRUART:CON?', 'START');
		try {
			harness.fake.sent();
			const refused = await call(harness, 'configure_uart_trigger', { qualifier: 'MORE' });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/qualifier cannot be used with condition START/);
			assertSent(harness.fake, ['TRSE?', 'TRUART:CON?']);
		} finally {
			harness.fake.replies.set('TRUART:CON?', uartReplies['TRUART:CON?']);
		}
	});

	it('refuses to write while the scope triggers on another type', async () => {
		harness.fake.replies.set('TRSE?', 'EDGE,SR,C1,HT,OFF');
		harness.fake.sent();
		try {
			const refused = await call(harness, 'configure_uart_trigger', { condition: 'START' });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/current type is EDGE.*Select Serial/);
			assertSent(harness.fake, ['TRSE?']);
		} finally {
			harness.fake.replies.set('TRSE?', uartReplies['TRSE?']);
		}
	});

	it('rejects a request that cannot reach the wire, sending nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { rx: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { rx: 'D0', rx_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { tx_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { bit_order: 'MSB', extra: 1 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { bit_orderr: 'MSB' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'DATA' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'DATA', qualifier: 'EQUAL' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'DATA', data: 41 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'START', data: 41 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'ERROR', qualifier: 'EQUAL' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { condition: 'BREAK' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { data: 256 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { data: -1 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { baud: 299 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { baud: 5_000_001 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { baud: 9600.5 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { data_length: 4 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { data_length: 9 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { parity: 'MARK' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { polarity: 'IDLE' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { stop_bits: 1.6 });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { trigger_source: 'SDA' });
		await assertInvalidSendsNothing(harness, 'configure_uart_trigger', { bit_order: 'MSB0' });
	});
});

const canReplies = {
	'TRSE?': 'SERIAL',
	'TRCAN:CANH?': 'C1,1.65V',
	'TRCAN:CON?': 'ID_AND_DATA',
	'TRCAN:IDL?': '11BITS',
	'TRCAN:ID?': '2048',
	'TRCAN:DATA?': '256',
	'TRCAN:DAT2?': '41',
	'TRCAN:BAUD?': '500k',
};

const canQueries = [
	'TRCAN:CANH?',
	'TRCAN:CON?',
	'TRCAN:IDL?',
	'TRCAN:ID?',
	'TRCAN:DATA?',
	'TRCAN:DAT2?',
	'TRCAN:BAUD?',
];

const wroteCan = (...commands: string[]) => ['TRSE?', ...commands, ...echoOf(canQueries, commands)];

describe('CAN serial trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(canReplies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads every field, hides the 11-bit and byte don\'t-care values behind "any" and spells the baud rate as a rate', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_can_trigger'));
		expect(state).toBeEqual({
			trigger_type: 'SERIAL',
			canh: 'C1',
			canh_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			condition: 'ID_AND_DATA',
			id_length: '11BITS',
			id: 'any',
			data: 'any',
			data2: 41,
			baud: 500000,
		});
		assertSent(harness.fake, ['TRSE?', ...canQueries]);
		await assertReadOnly(harness.client, 'get_can_trigger');
	});

	it('reads the 29-bit don\'t-care identifier as "any" and a custom baud rate as the rate', async () => {
		harness.fake.replies.set('TRCAN:IDL?', '29BITS');
		harness.fake.replies.set('TRCAN:ID?', '536870912');
		harness.fake.replies.set('TRCAN:BAUD?', 'CUSTOM,33333');
		try {
			const state = payload(await call(harness, 'get_can_trigger'));
			expect(state.id).toBe('any');
			expect(state.id_length).toBe('29BITS');
			expect(state.baud).toBe(33333);
		} finally {
			for (const [query, reply] of Object.entries(canReplies)) harness.fake.replies.set(query, reply);
		}
	});

	it('sends the guide CANH example as one positional command', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_can_trigger', { canh: 'C3', canh_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['TRCAN:CANH C3,0.2V']);
		assertSent(harness.fake, wroteCan('TRCAN:CANH C3,0.2V'));
	});

	it('takes every condition and sends the identifier length before the identifier', async () => {
		harness.fake.sent();
		for (const condition of ['START', 'REMOTE', 'ERROR']) {
			const result = payload(await call(harness, 'configure_can_trigger', { condition }));
			expect(result.commands).toBeEqual([`TRCAN:CON ${condition}`]);
		}
		const id = payload(await call(harness, 'configure_can_trigger', { condition: 'ID', id: 41, id_length: '11BITS' }));
		expect(id.commands).toBeEqual(['TRCAN:CON ID', 'TRCAN:IDL 11BITS', 'TRCAN:ID 41']);
		const frame = payload(
			await call(harness, 'configure_can_trigger', {
				condition: 'ID_AND_DATA',
				id_length: '29BITS',
				id: 41,
				data: 41,
				data2: 12,
			}),
		);
		expect(frame.commands).toBeEqual([
			'TRCAN:CON ID_AND_DATA',
			'TRCAN:IDL 29BITS',
			'TRCAN:ID 41',
			'TRCAN:DATA 41',
			'TRCAN:DAT2 12',
		]);
	});

	it("maps `any` onto the don't-care value the identifier length decides", async () => {
		harness.fake.sent();
		const standard = payload(
			await call(harness, 'configure_can_trigger', { condition: 'ID_AND_DATA', id_length: '11BITS', id: 'any' }),
		);
		expect(standard.commands).toBeEqual(['TRCAN:CON ID_AND_DATA', 'TRCAN:IDL 11BITS', 'TRCAN:ID 2048']);
		expect(standard.warnings).toBe(undefined);
		expect((standard.state as Record<string, unknown>).id).toBe('any');
		const extended = payload(
			await call(harness, 'configure_can_trigger', {
				condition: 'ID_AND_DATA',
				id_length: '29BITS',
				id: 'any',
				data: 'any',
				data2: 'any',
			}),
		);
		expect(extended.commands).toBeEqual([
			'TRCAN:CON ID_AND_DATA',
			'TRCAN:IDL 29BITS',
			'TRCAN:ID 536870912',
			'TRCAN:DATA 256',
			'TRCAN:DAT2 256',
		]);
	});

	it('spells a standard baud rate and sends every other rate as CUSTOM', async () => {
		harness.fake.sent();
		const standard = payload(await call(harness, 'configure_can_trigger', { baud: 500000 }));
		expect(standard.commands).toBeEqual(['TRCAN:BAUD 500k']);
		expect(standard.warnings).toBe(undefined);
		expect((standard.state as Record<string, unknown>).baud).toBe(500000);
		assertSent(harness.fake, wroteCan('TRCAN:BAUD 500k'));
		harness.fake.replies.set('TRCAN:BAUD?', 'CUSTOM,250000');
		try {
			// The guide's own list prints 250 without its k and 59k for 50k; neither spelling is sent, so both rates
			// reach the scope through the documented CUSTOM form.
			const custom = payload(await call(harness, 'configure_can_trigger', { baud: 250000 }));
			expect(custom.commands).toBeEqual(['TRCAN:BAUD CUSTOM,250000']);
			expect(custom.warnings).toBe(undefined);
			expect((custom.state as Record<string, unknown>).baud).toBe(250000);
			harness.fake.replies.set('TRCAN:BAUD?', 'CUSTOM,50000');
			const fifty = payload(await call(harness, 'configure_can_trigger', { baud: 50000 }));
			expect(fifty.commands).toBeEqual(['TRCAN:BAUD CUSTOM,50000']);
		} finally {
			harness.fake.replies.set('TRCAN:BAUD?', canReplies['TRCAN:BAUD?']);
		}
	});

	it('checks a condition-dependent field sent without the condition against TRCAN:CON?', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_can_trigger', { data: 12 }));
		expect(result.commands).toBeEqual(['TRCAN:DATA 12']);
		assertSent(harness.fake, ['TRSE?', 'TRCAN:CON?', 'TRCAN:DATA 12', 'TRCAN:DATA?']);
		harness.fake.replies.set('TRCAN:CON?', 'REMOTE');
		try {
			harness.fake.sent();
			const refused = await call(harness, 'configure_can_trigger', { data2: 12 });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/data2 cannot be used with condition REMOTE/);
			assertSent(harness.fake, ['TRSE?', 'TRCAN:CON?']);
		} finally {
			harness.fake.replies.set('TRCAN:CON?', canReplies['TRCAN:CON?']);
		}
	});

	it('refuses to write while the scope triggers on another type', async () => {
		harness.fake.replies.set('TRSE?', 'EDGE,SR,C1,HT,OFF');
		harness.fake.sent();
		try {
			const refused = await call(harness, 'configure_can_trigger', { condition: 'START' });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/current type is EDGE.*Select Serial/);
			assertSent(harness.fake, ['TRSE?']);
		} finally {
			harness.fake.replies.set('TRSE?', canReplies['TRSE?']);
		}
	});

	it('rejects a request that cannot reach the wire, sending nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { canh: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { canh: 'D0', canh_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { canh_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { canl: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { condition: 'ID', extra: 1 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { conditon: 'ID' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { condition: 'DATA' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { condition: 'START', id: 41 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { condition: 'ID', data: 41 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id: 41 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id: 'any' });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id_length: '11BITS', id: 2048 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id_length: '29BITS', id: 536870912 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id_length: '10BITS', id: 41 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { id_length: '11BITS', id: -1 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { data: 256 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { data2: -1 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { baud: 4999 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { baud: 1000001 });
		await assertInvalidSendsNothing(harness, 'configure_can_trigger', { baud: 500000.5 });
	});
});

const linReplies = {
	'TRSE?': 'SERIAL',
	'TRLIN:SRC?': 'C1,1.65V',
	'TRLIN:CON?': 'ID_AND_DATA',
	'TRLIN:ID?': '64',
	'TRLIN:DATA?': '256',
	'TRLIN:DAT2?': '41',
	'TRLIN:BAUD?': '9600',
};

const linQueries = ['TRLIN:SRC?', 'TRLIN:CON?', 'TRLIN:ID?', 'TRLIN:DATA?', 'TRLIN:DAT2?', 'TRLIN:BAUD?'];

const wroteLin = (...commands: string[]) => ['TRSE?', ...commands, ...echoOf(linQueries, commands)];

describe('LIN serial trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(linReplies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads every field and hides the don\'t-care identifier and byte behind "any"', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_lin_trigger'));
		expect(state).toBeEqual({
			trigger_type: 'SERIAL',
			src: 'C1',
			src_threshold: { value: 1.65, unit: 'V', raw: '1.65V' },
			condition: 'ID_AND_DATA',
			id: 'any',
			data: 'any',
			data2: 41,
			baud: 9600,
		});
		assertSent(harness.fake, ['TRSE?', ...linQueries]);
		await assertReadOnly(harness.client, 'get_lin_trigger');
	});

	it('reads a custom baud rate as the rate', async () => {
		harness.fake.replies.set('TRLIN:BAUD?', 'CUSTOM,500');
		try {
			expect(payload(await call(harness, 'get_lin_trigger')).baud).toBe(500);
		} finally {
			harness.fake.replies.set('TRLIN:BAUD?', linReplies['TRLIN:BAUD?']);
		}
	});

	it('sends the guide SRC example as one positional command', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_lin_trigger', { src: 'C3', src_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['TRLIN:SRC C3,0.2V']);
		assertSent(harness.fake, wroteLin('TRLIN:SRC C3,0.2V'));
	});

	it('takes every condition and sends the identifier before the data bytes', async () => {
		harness.fake.sent();
		for (const condition of ['BREAK', 'DATA_ERROR']) {
			const result = payload(await call(harness, 'configure_lin_trigger', { condition }));
			expect(result.commands).toBeEqual([`TRLIN:CON ${condition}`]);
		}
		const id = payload(await call(harness, 'configure_lin_trigger', { condition: 'ID', id: 41 }));
		expect(id.commands).toBeEqual(['TRLIN:CON ID', 'TRLIN:ID 41']);
		const frame = payload(
			await call(harness, 'configure_lin_trigger', { condition: 'ID_AND_DATA', id: 41, data: 41, data2: 12 }),
		);
		expect(frame.commands).toBeEqual(['TRLIN:CON ID_AND_DATA', 'TRLIN:ID 41', 'TRLIN:DATA 41', 'TRLIN:DAT2 12']);
	});

	it("maps `any` onto the don't-care values without needing the condition", async () => {
		harness.fake.replies.set('TRLIN:DAT2?', '256');
		harness.fake.sent();
		try {
			const result = payload(await call(harness, 'configure_lin_trigger', { id: 'any', data: 'any', data2: 'any' }));
			expect(result.commands).toBeEqual(['TRLIN:ID 64', 'TRLIN:DATA 256', 'TRLIN:DAT2 256']);
			expect(result.warnings).toBe(undefined);
			const state = result.state as Record<string, unknown>;
			expect([state.id, state.data, state.data2]).toBeEqual(['any', 'any', 'any']);
			assertSent(harness.fake, [
				'TRSE?',
				'TRLIN:CON?',
				...(result.commands as string[]),
				...echoOf(linQueries, result.commands as string[]),
			]);
		} finally {
			harness.fake.replies.set('TRLIN:DAT2?', linReplies['TRLIN:DAT2?']);
		}
	});

	it('sends a standard baud rate on its own and every other rate as CUSTOM', async () => {
		harness.fake.sent();
		const standard = payload(await call(harness, 'configure_lin_trigger', { baud: 9600 }));
		expect(standard.commands).toBeEqual(['TRLIN:BAUD 9600']);
		expect(standard.warnings).toBe(undefined);
		expect((standard.state as Record<string, unknown>).baud).toBe(9600);
		assertSent(harness.fake, wroteLin('TRLIN:BAUD 9600'));
		harness.fake.replies.set('TRLIN:BAUD?', 'CUSTOM,500');
		try {
			// The trigger page documents 300 to 20000, the decode page 300 to 2000; both ends of the trigger range go out.
			const slow = payload(await call(harness, 'configure_lin_trigger', { baud: 500 }));
			expect(slow.commands).toBeEqual(['TRLIN:BAUD CUSTOM,500']);
			expect(slow.warnings).toBe(undefined);
			expect((slow.state as Record<string, unknown>).baud).toBe(500);
			harness.fake.replies.set('TRLIN:BAUD?', 'CUSTOM,20000');
			const fast = payload(await call(harness, 'configure_lin_trigger', { baud: 20000 }));
			expect(fast.commands).toBeEqual(['TRLIN:BAUD CUSTOM,20000']);
			expect(fast.warnings).toBe(undefined);
		} finally {
			harness.fake.replies.set('TRLIN:BAUD?', linReplies['TRLIN:BAUD?']);
		}
	});

	it('checks a condition-dependent field sent without the condition against TRLIN:CON?', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_lin_trigger', { data: 12 }));
		expect(result.commands).toBeEqual(['TRLIN:DATA 12']);
		assertSent(harness.fake, ['TRSE?', 'TRLIN:CON?', 'TRLIN:DATA 12', 'TRLIN:DATA?']);
		harness.fake.replies.set('TRLIN:CON?', 'BREAK');
		try {
			harness.fake.sent();
			const refused = await call(harness, 'configure_lin_trigger', { id: 41 });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/id cannot be used with condition BREAK/);
			assertSent(harness.fake, ['TRSE?', 'TRLIN:CON?']);
		} finally {
			harness.fake.replies.set('TRLIN:CON?', linReplies['TRLIN:CON?']);
		}
	});

	it('reports an unreadable condition and sends the request anyway', async () => {
		harness.fake.replies.set('TRLIN:CON?', 'ID_ONLY');
		try {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_lin_trigger', { id: 41 }));
			expect(
				(result.warnings as string[]).some((warning) => /condition response "ID_ONLY".*unchecked/.test(warning)),
			).toBeTruthy();
			expect(result.commands).toBeEqual(['TRLIN:ID 41']);
		} finally {
			harness.fake.replies.set('TRLIN:CON?', linReplies['TRLIN:CON?']);
		}
	});

	it('refuses to write while the scope triggers on another type', async () => {
		harness.fake.replies.set('TRSE?', 'EDGE,SR,C1,HT,OFF');
		harness.fake.sent();
		try {
			const refused = await call(harness, 'configure_lin_trigger', { condition: 'BREAK' });
			expect(refused.isError).toBe(true);
			expect(String(payload(refused).error)).toMatchRegex(/current type is EDGE.*Select Serial/);
			assertSent(harness.fake, ['TRSE?']);
		} finally {
			harness.fake.replies.set('TRSE?', linReplies['TRSE?']);
		}
	});

	it('rejects a request that cannot reach the wire, sending nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { src: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { src: 'D0', src_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { src_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { canh: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { condition: 'ID', extra: 1 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { conditon: 'ID' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { condition: 'DATA' });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { condition: 'BREAK', id: 41 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { condition: 'ID', data: 41 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { condition: 'DATA_ERROR', data2: 41 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { id: 64 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { id: -1 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { id: 41.5 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { data: 256 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { data2: -1 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { baud: 299 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { baud: 20_001 });
		await assertInvalidSendsNothing(harness, 'configure_lin_trigger', { baud: 9600.5 });
	});
});

describe('serial trigger support', () => {
	it('sends nothing to a family the guide lists without the serial trigger', async () => {
		const older = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1102X,SDS1EBAC0L0001,7.6.1.20' });
		try {
			await older.client.callTool({ name: 'identify', arguments: {} });
			older.fake.sent();
			assertCapabilityError(await older.client.callTool({ name: 'get_i2c_trigger', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_i2c_trigger', arguments: { condition: 'START' } }),
				'SDS1102X',
			);
			assertCapabilityError(await older.client.callTool({ name: 'get_spi_trigger', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_spi_trigger', arguments: { bit_order: 'MSB' } }),
				'SDS1102X',
			);
			assertCapabilityError(await older.client.callTool({ name: 'get_uart_trigger', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_uart_trigger', arguments: { bit_order: 'MSB' } }),
				'SDS1102X',
			);
			assertCapabilityError(await older.client.callTool({ name: 'get_can_trigger', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_can_trigger', arguments: { condition: 'START' } }),
				'SDS1102X',
			);
			assertCapabilityError(await older.client.callTool({ name: 'get_lin_trigger', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_lin_trigger', arguments: { condition: 'BREAK' } }),
				'SDS1102X',
			);
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('rejects a source channel the scope does not have', async () => {
		const two = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0001,7.6.1.20' });
		try {
			await two.client.callTool({ name: 'identify', arguments: {} });
			two.fake.sent();
			const result = await two.client.callTool({
				name: 'configure_i2c_trigger',
				arguments: { sda: 'C4', sda_threshold: '1V' },
			});
			assertCapabilityError(result, 'SDS1202X-E');
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
