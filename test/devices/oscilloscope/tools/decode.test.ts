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

const replies = { 'DCST?': 'ON' };

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('decode tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the decode state and names the command-only settings', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_decode'));
		expect(state.enabled).toBe(true);
		expect(state.raw).toBe('ON');
		expect(state.write_only).toBeEqual(['DCPA', 'B<n>:DCIC', 'B<n>:DCSP', 'B<n>:DCUT', 'B<n>:DCCN', 'B<n>:DCLN']);
		expect(state.warnings).toBe(undefined);
		assertSent(harness.fake, ['DCST?']);
		await assertReadOnly(harness.client, 'get_decode');
	});

	it('sends the single-pair guide example and reads the state back', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_decode', { bus: 'B1' }));
		expect(result.commands).toBeEqual(['DCPA BUS,B1']);
		expect(result.state).toBeEqual({ enabled: true, raw: 'ON' });
		assertSent(harness.fake, ['DCPA BUS,B1', 'DCST?']);
	});

	it('enables decode and batches the multi-pair guide example into one DCPA', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_decode', {
				enabled: true,
				bus: 'B2',
				list: 'D2',
				format: 'HEX',
				list_lines: 5,
			}),
		);
		expect(result.commands).toBeEqual(['DCST ON', 'DCPA BUS,B2,LIST,D2,FOMT,HEX,LSNM,5']);
		assertSent(harness.fake, ['DCST ON', 'DCPA BUS,B2,LIST,D2,FOMT,HEX,LSNM,5', 'DCST?']);
	});

	it('keeps the copy direction explicit and disables decode', async () => {
		harness.fake.sent();
		const copy = payload(await call(harness, 'configure_decode', { copy: 'DC_TO_TR' }));
		expect(copy.commands).toBeEqual(['DCPA LINK,DC_TO_TR']);
		const off = payload(await call(harness, 'configure_decode', { enabled: false }));
		expect(off.commands).toBeEqual(['DCST OFF']);
	});

	it('warns that a list scroll cannot be checked without the line count', async () => {
		const result = await call(harness, 'configure_decode', { list_scroll: 7 });
		expect(String(payload(result).warnings)).toMatchRegex(
			/list_scroll was not checked against the current number of list lines/,
		);
		expect(payload(result).commands).toBeEqual(['DCPA LSSC,7']);
		expect(payload(await call(harness, 'configure_decode', { list_scroll: 3, list_lines: 5 })).commands).toBeEqual([
			'DCPA LSSC,3,LSNM,5',
		]);
	});

	it('rejects an empty request, an out-of-range line and a scroll beyond the list', async () => {
		await assertInvalidSendsNothing(harness, 'configure_decode', {});
		await assertInvalidSendsNothing(harness, 'configure_decode', { list_lines: 8 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { list_scroll: 0 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { list_scroll: 6, list_lines: 5 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 'B3' });
	});

	it('sends the threshold-only I2C guide example', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_i2c_decode', { bus: 'B2', scl_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['B2:DCIC SCLT,0.2V']);
		expect(result.write_only).toBeEqual(['B<n>:DCIC']);
		expect(result.state).toBe(undefined);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, ['B2:DCIC SCLT,0.2V']);
	});

	it('sends the digital I2C guide example and reports the MSO option as unknown', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_i2c_decode', {
			bus: 'B1',
			display: true,
			scl: 'D0',
			sda: 'D1',
			read_write: true,
		});
		expect(payload(result).commands).toBeEqual(['B1:DCIC DIS,ON,SCL,D0,SDA,D1,RW,ON']);
		assertUnknownWarning(result, 'mso_xe');
		assertSent(harness.fake, ['B1:DCIC DIS,ON,SCL,D0,SDA,D1,RW,ON']);
	});

	it('keeps analog sources and their thresholds together', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_i2c_decode', {
				bus: 'B1',
				scl: 'C1',
				scl_threshold: '1.5V',
				sda: 'C2',
				sda_threshold: '-0.5',
			}),
		);
		expect(result.commands).toBeEqual(['B1:DCIC SCL,C1,SCLT,1.5V,SDA,C2,SDAT,-0.5']);
		assertSent(harness.fake, ['B1:DCIC SCL,C1,SCLT,1.5V,SDA,C2,SDAT,-0.5']);
	});

	it('sends the threshold-only SPI guide example', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_spi_decode', { bus: 'B2', clk_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['B2:DCSP CLKT,0.2V']);
		assertSent(harness.fake, ['B2:DCSP CLKT,0.2V']);
	});

	it('sends the multi-parameter SPI guide example with the clock timeout', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_spi_decode', {
			bus: 'B1',
			display: true,
			clk: 'D0',
			mosi: 'D1',
			chip_select_type: 'TIMEOUT',
			timeout: '2uS',
			bit_order: 'MSB',
			data_length: 32,
		});
		const expected = 'B1:DCSP DIS,ON,CLK,D0,MOSI,D1,CSTP,TIMEOUT,TIM,2uS,BIT,MSB,DLEN,32';
		expect(payload(result).commands).toBeEqual([expected]);
		assertUnknownWarning(result, 'mso_xe');
		assertSent(harness.fake, [expected]);
	});

	it('orders the SPI parameters as the guide lists them for a CS chip select', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_spi_decode', {
				bus: 'B1',
				clk: 'C1',
				clk_threshold: '1.5V',
				edge: 'FALLING',
				miso: 'C2',
				miso_threshold: '0',
				chip_select_type: 'CS',
				cs: 'C3',
				cs_threshold: '-0.5V',
				bit_order: 'LSB',
				data_length: 4,
			}),
		);
		const expected = 'B1:DCSP CLK,C1,CLKT,1.5V,EDGE,FALLING,MISO,C2,MISOT,0,CSTP,CS,CS,C3,CST,-0.5V,BIT,LSB,DLEN,4';
		expect(result.commands).toBeEqual([expected]);
		assertSent(harness.fake, [expected]);
	});

	it('sends an active-low chip select with its own source', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_spi_decode', {
				bus: 'B2',
				chip_select_type: 'NCS',
				ncs: 'C4',
				ncs_threshold: '1V',
			}),
		);
		expect(result.commands).toBeEqual(['B2:DCSP CSTP,NCS,NCS,C4,NCST,1V']);
		assertSent(harness.fake, ['B2:DCSP CSTP,NCS,NCS,C4,NCST,1V']);
	});

	it('rejects a chip-select type without its source, value or unit and an out-of-range data length', async () => {
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', chip_select_type: 'CS' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', chip_select_type: 'NCS' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', chip_select_type: 'TIMEOUT' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', {
			bus: 'B1',
			chip_select_type: 'TIMEOUT',
			timeout: '2V',
		});
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', {
			bus: 'B1',
			chip_select_type: 'CS',
			cs: 'C1',
		});
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', clk: 'D0', clk_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', mosi: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', edge: 'BOTH' });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', data_length: 3 });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', data_length: 33 });
		await assertInvalidSendsNothing(harness, 'configure_spi_decode', { bus: 'B1', bit_order: 'MID' });
	});

	it('rejects a bus without parameters, a missing or misplaced threshold and a wrong unit', async () => {
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', { bus: 'B1' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', { bus: 'B1', scl: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', { bus: 'B1', sda: 'C2' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', {
			bus: 'B1',
			scl: 'D0',
			scl_threshold: '1V',
		});
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', {
			bus: 'B1',
			scl: 'C1',
			scl_threshold: '200MV',
		});
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', { bus: 'B1', scl: 'D16', scl_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_i2c_decode', { display: true });
	});

	it('sends the threshold-only UART guide example, whose prose asks for RXT but writes RX', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_uart_decode', { bus: 'B2', rx_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['B2:DCUT RXT,0.2V']);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, ['B2:DCUT RXT,0.2V']);
	});

	it('sends the multi-parameter UART guide example with the commas the guide drops', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_uart_decode', {
			bus: 'B1',
			display: true,
			rx: 'D0',
			baud: 9600,
			parity: 'ODD',
			stop_bits: 2,
			polarity: 'HIGH',
			bit_order: 'MSB',
		});
		const expected = 'B1:DCUT DIS,ON,RX,D0,BAUD,9600,PAR,ODD,STOP,2,POL,HIGH,BIT,MSB';
		expect(payload(result).commands).toBeEqual([expected]);
		assertUnknownWarning(result, 'mso_xe');
		assertSent(harness.fake, [expected]);
	});

	it('orders the UART parameters as the guide lists them and keeps a fractional stop bit', async () => {
		harness.fake.sent();
		const expected = 'B1:DCUT RX,C1,RXT,1.5V,TX,C2,TXT,-0.5,BAUD,50000000,DLEN,5,STOP,1.5,POL,LOW,BIT,LSB';
		const result = payload(
			await call(harness, 'configure_uart_decode', {
				bus: 'B1',
				rx: 'C1',
				rx_threshold: '1.5V',
				tx: 'C2',
				tx_threshold: '-0.5',
				baud: 50_000_000,
				data_length: 5,
				stop_bits: 1.5,
				polarity: 'LOW',
				bit_order: 'LSB',
			}),
		);
		expect(result.commands).toBeEqual([expected]);
		assertSent(harness.fake, [expected]);
	});

	it('rejects UART values outside the guide sets', async () => {
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', baud: 299 });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', baud: 50_000_001 });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', baud: '9600' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', data_length: 4 });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', data_length: 9 });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', parity: 'MARK' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', stop_bits: 1.2 });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', polarity: 'RISING' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', rx: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', tx: 'D0', tx_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_uart_decode', { bus: 'B1', rx_threshold: '200MV' });
	});

	it('sends the threshold-only CAN guide example', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_can_decode', { bus: 'B2', canh_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['B2:DCCN CANHT,0.2V']);
		assertSent(harness.fake, ['B2:DCCN CANHT,0.2V']);
	});

	it("sends the multi-parameter CAN guide example with the syntax table's CAN_H, not the example's CANH", async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_can_decode', {
			bus: 'B1',
			display: true,
			canh: 'D0',
			signal: 'CAN_H',
			baud: 9600,
		});
		const expected = 'B1:DCCN DIS,ON,CANH,D0,SRC,CAN_H,BAUD,9600';
		expect(payload(result).commands).toBeEqual([expected]);
		assertUnknownWarning(result, 'mso_xe');
		assertSent(harness.fake, [expected]);
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', signal: 'CANH' });
	});

	it('orders the CAN parameters as the guide lists them', async () => {
		harness.fake.sent();
		const expected = 'B1:DCCN CANH,C1,CANHT,1.5V,CANL,C2,CANLT,-0.5,SRC,SUB_L,BAUD,1000000';
		const result = payload(
			await call(harness, 'configure_can_decode', {
				bus: 'B1',
				canh: 'C1',
				canh_threshold: '1.5V',
				canl: 'C2',
				canl_threshold: '-0.5',
				signal: 'SUB_L',
				baud: 1_000_000,
			}),
		);
		expect(result.commands).toBeEqual([expected]);
		assertSent(harness.fake, [expected]);
	});

	it('rejects CAN values outside the guide sets', async () => {
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1' });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', baud: 4999 });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', baud: 1_000_001 });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', signal: 'CAN_HL' });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', canh: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', canl: 'D1', canl_threshold: '1V' });
	});

	it('sends the threshold-only LIN guide example', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_lin_decode', { bus: 'B2', src_threshold: '0.2V' }));
		expect(result.commands).toBeEqual(['B2:DCLN SRCT,0.2V']);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, ['B2:DCLN SRCT,0.2V']);
	});

	it("sends the LIN guide example as B<n>:DCLN, not the example's B1:DCCN, and flags its 9600 baud", async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_lin_decode', { bus: 'B1', display: true, src: 'D0', baud: 9600 }),
		);
		const expected = 'B1:DCLN DIS,ON,SRC,D0,BAUD,9600';
		expect(result.commands).toBeEqual([expected]);
		assertSent(harness.fake, [expected]);
		expect(
			(result.warnings as string[]).some((warning) =>
				/LIN baud rate 9600 is above 2000 and is unverified/.test(warning),
			),
		).toBeTruthy();
	});

	it('keeps the LIN baud inside the range the trigger subsystem documents', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_lin_decode', { bus: 'B2', src: 'C3', src_threshold: '1V', baud: 2000 }),
		);
		expect(result.commands).toBeEqual(['B2:DCLN SRC,C3,SRCT,1V,BAUD,2000']);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, ['B2:DCLN SRC,C3,SRCT,1V,BAUD,2000']);
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1' });
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1', baud: 299 });
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1', baud: 20_001 });
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1', src: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1', src: 'D0', src_threshold: '1V' });
	});

	it('never cross-wires the CAN and LIN mnemonics or their parameter names', async () => {
		harness.fake.sent();
		const can = payload(await call(harness, 'configure_can_decode', { bus: 'B1', canh: 'C1', canh_threshold: '1V' }));
		const lin = payload(await call(harness, 'configure_lin_decode', { bus: 'B1', src: 'C1', src_threshold: '1V' }));
		expect(can.commands).toBeEqual(['B1:DCCN CANH,C1,CANHT,1V']);
		expect(lin.commands).toBeEqual(['B1:DCLN SRC,C1,SRCT,1V']);
		assertSent(harness.fake, ['B1:DCCN CANH,C1,CANHT,1V', 'B1:DCLN SRC,C1,SRCT,1V']);
		await assertInvalidSendsNothing(harness, 'configure_lin_decode', { bus: 'B1', canh: 'C1', canh_threshold: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_can_decode', { bus: 'B1', src: 'C1', src_threshold: '1V' });
	});
});

describe('decode support', () => {
	it('sends nothing to a family the guide lists without decode', async () => {
		const older = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1102X,SDS1EBAC0L0001,7.6.1.20' });
		try {
			await older.client.callTool({ name: 'identify', arguments: {} });
			older.fake.sent();
			assertCapabilityError(await older.client.callTool({ name: 'get_decode', arguments: {} }), 'SDS1102X');
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_decode', arguments: { enabled: true } }),
				'SDS1102X',
			);
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('rejects a channel the scope does not have', async () => {
		const two = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0001,7.6.1.20' });
		try {
			await two.client.callTool({ name: 'identify', arguments: {} });
			two.fake.sent();
			const result = await two.client.callTool({
				name: 'configure_i2c_decode',
				arguments: { bus: 'B1', scl: 'C4', scl_threshold: '1V' },
			});
			assertCapabilityError(result, 'SDS1202X-E');
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
