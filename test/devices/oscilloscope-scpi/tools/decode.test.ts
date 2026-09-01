import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':DECode?': 'ON',
	':DECode:LIST?': 'D1',
	':DECode:LIST:LINE?': '6',
	':DECode:LIST:SCRoll?': '3',
	':DECode:BUS1?': 'ON',
	':DECode:BUS1:FORMat?': 'HEX',
	':DECode:BUS1:PROTocol?': 'IIC',
	':DECode:BUS1:RESult?': 'iic,address,rw,data;0x50,W,1,0x12;0x50,R,0,0x56;0x51,W,1,0x78;',
	':DECode:BUS1:IIC:SCLSource?': 'C1',
	':DECode:BUS1:IIC:SCLThreshold?': '1.50E+00',
	':DECode:BUS1:IIC:SDASource?': 'C2',
	':DECode:BUS1:IIC:SDAThreshold?': '1.50E+00',
	':DECode:BUS1:IIC:RWBit?': 'ON',
	':DECode:BUS1:UART:RXSource?': 'C1',
	':DECode:BUS1:UART:RXThreshold?': '1.50E+00',
	':DECode:BUS1:UART:BAUD?': 'CUSTom,250000',
	':DECode:BUS1:UART:BITorder?': 'LSB',
	':DECode:BUS1:UART:STOP?': '1.5',
	':DECode:BUS2?': 'OFF',
	':DECode:BUS2:FORMat?': 'BINary',
	':DECode:BUS2:PROTocol?': 'CANFd',
	':DECode:BUS2:SPI:CLKSource?': 'D3',
	':DECode:BUS2:SPI:CLKThreshold?': '1.50E+00',
	':DECode:BUS2:SPI:MISOSource?': 'DIS',
	':DECode:BUS2:SPI:CSTYpe?': 'TIMeout,1.00E-06',
	':DECode:BUS2:SPI:DLENgth?': '8',
	':DECode:BUS2:CANFd:SOURce?': 'C1',
	':DECode:BUS2:CANFd:THReshold?': '1.50E+00',
	':DECode:BUS2:CANFd:BAUDNominal?': '250kbps',
	':DECode:BUS2:CANFd:BAUDData?': '2Mbps',
	':DECode:BUS1:CAN:SOURce?': 'C1',
	':DECode:BUS1:CAN:THReshold?': '1.50E+00',
	':DECode:BUS1:CAN:BAUD?': '500kbps',
	':DECode:BUS1:LIN:SOURce?': 'D2',
	':DECode:BUS1:LIN:BAUD?': 'CUSTom,4800',
	':DECode:BUS1:FLEXray:BAUD?': '10Mbps',
	':DECode:BUS1:IIS:LCH?': 'LOW',
	':DECode:BUS1:IIS:ANNotate?': 'ALL',
	':DECode:BUS1:M1553:SOURce?': 'C1',
	':DECode:BUS1:M1553:UTHReshold?': '2.00E+00',
	':DECode:BUS1:M1553:LTHReshold?': '1.00E+00',
	':DECode:BUS1:SENT:CLOCk?': '1.00E-06',
	':DECode:BUS1:SENT:CRC?': 'ON',
	':DECode:BUS1:MANChester:BAUD?': '9600',
	':DECode:BUS1:MANChester:DSIZe?': '32',
	':DECode:BUS1:IIS:AVARiant?': 'I2S',
	':DECode:BUS1:IIS:SBIT?': '0',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[] | undefined) ?? [];
const mentions = (result: Record<string, unknown>, text: string): boolean =>
	warnings(result).some((warning) => warning.includes(text));

describe('EN11F decode tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the decode state, the list and the parameters of the protocol the bus is set to', async () => {
		const state = payload(await call(harness, 'get_decode', { bus: 1 }));
		expect(state).toBeEqual({
			enabled: true,
			list: 'D1',
			list_lines: 6,
			list_scroll: 3,
			bus: 1,
			bus_enabled: true,
			protocol: 'IIC',
			format: 'HEX',
			clock_source: 'C1',
			clock_threshold: { value: 1.5, raw: '1.50E+00' },
			data_source: 'C2',
			data_threshold: { value: 1.5, raw: '1.50E+00' },
			read_write: true,
		});
		assertSent(harness.fake, [
			':DECode?',
			':DECode:LIST?',
			':DECode:LIST:LINE?',
			':DECode:LIST:SCRoll?',
			':DECode:BUS1?',
			':DECode:BUS1:PROTocol?',
			':DECode:BUS1:FORMat?',
			':DECode:BUS1:IIC:SCLSource?',
			':DECode:BUS1:IIC:SCLThreshold?',
			':DECode:BUS1:IIC:SDASource?',
			':DECode:BUS1:IIC:SDAThreshold?',
			':DECode:BUS1:IIC:RWBit?',
		]);
		await assertReadOnly(harness.client, 'get_decode');
	});

	it('reads bus 2 with the rows of its optional protocol and warns that availability is unknown', async () => {
		const state = payload(await call(harness, 'get_decode', { bus: 2 }));
		expect(state.bus).toBe(2);
		expect(state.bus_enabled).toBe(false);
		expect(state.protocol).toBe('CANFd');
		expect(state.baud).toBe('250kbps');
		expect(state.data_baud).toBe('2Mbps');
		expect(mentions(state, 'optional feature')).toBeTruthy();
		assertSent(harness.fake, [
			':DECode?',
			':DECode:LIST?',
			':DECode:LIST:LINE?',
			':DECode:LIST:SCRoll?',
			':DECode:BUS2?',
			':DECode:BUS2:PROTocol?',
			':DECode:BUS2:FORMat?',
			':DECode:BUS2:CANFd:SOURce?',
			':DECode:BUS2:CANFd:THReshold?',
			':DECode:BUS2:CANFd:BAUDNominal?',
			':DECode:BUS2:CANFd:BAUDData?',
		]);
	});

	it('asks for no parameter of a protocol the guide documents none for', async () => {
		harness.fake.replies.set(':DECode:BUS2:PROTocol?', 'USB20');
		try {
			const state = payload(await call(harness, 'get_decode', { bus: 2 }));
			expect(state.protocol).toBe('USB20');
			expect(mentions(state, 'reads no parameter')).toBeTruthy();
			assertSent(harness.fake, [
				':DECode?',
				':DECode:LIST?',
				':DECode:LIST:LINE?',
				':DECode:LIST:SCRoll?',
				':DECode:BUS2?',
				':DECode:BUS2:PROTocol?',
				':DECode:BUS2:FORMat?',
			]);
		} finally {
			harness.fake.replies.set(':DECode:BUS2:PROTocol?', 'CANFd');
		}
	});

	it('writes the decode function, the list and one IIC bus, then reads back what it set', async () => {
		const result = payload(
			await call(harness, 'configure_decode', {
				bus: 1,
				enabled: true,
				list: 'D1',
				list_lines: 6,
				list_scroll: 3,
				bus_enabled: true,
				protocol: 'IIC',
				format: 'HEX',
				clock_source: 'C1',
				clock_threshold: 1.5,
				data_source: 'C2',
				data_threshold: 1.5,
				read_write: true,
			}),
		);
		expect(result.commands).toBeEqual([
			':DECode ON',
			':DECode:LIST D1',
			':DECode:LIST:LINE 6',
			':DECode:LIST:SCRoll 3',
			':DECode:BUS1 ON',
			':DECode:BUS1:PROTocol IIC',
			':DECode:BUS1:FORMat HEX',
			':DECode:BUS1:IIC:SCLSource C1',
			':DECode:BUS1:IIC:SCLThreshold 1.50E+00',
			':DECode:BUS1:IIC:SDASource C2',
			':DECode:BUS1:IIC:SDAThreshold 1.50E+00',
			':DECode:BUS1:IIC:RWBit ON',
		]);
		expect((result.state as Record<string, unknown>).protocol).toBe('IIC');
		expect(warnings(result)).toBeEqual([]);
		harness.fake.sent();
	});

	it('addresses bus 2 with the same rows and warns about a digital line', async () => {
		const result = payload(
			await call(harness, 'configure_decode', {
				bus: 2,
				protocol: 'SPI',
				clock_source: 'D3',
				clock_threshold: 1.5,
				miso_source: 'DIS',
				cs_type: 1e-6,
				data_length: 8,
			}),
		);
		expect(result.commands).toBeEqual([
			':DECode:BUS2:PROTocol SPI',
			':DECode:BUS2:SPI:CLKSource D3',
			':DECode:BUS2:SPI:CLKThreshold 1.50E+00',
			':DECode:BUS2:SPI:MISOSource DIS',
			':DECode:BUS2:SPI:CSTYpe TIMeout,1.00E-06',
			':DECode:BUS2:SPI:DLENgth 8',
		]);
		expect(mentions(result, 'MSO option')).toBeTruthy();
		harness.fake.sent();
	});

	it('reads a custom baud rate and a fractional stop bit back', async () => {
		const result = payload(
			await call(harness, 'configure_decode', { bus: 1, protocol: 'UART', baud: 250_000, stop_bits: 1.5 }),
		);
		expect(result.commands).toBeEqual([
			':DECode:BUS1:PROTocol UART',
			':DECode:BUS1:UART:BAUD CUSTom,250000',
			':DECode:BUS1:UART:STOP 1.5',
		]);
		expect((result.state as Record<string, unknown>).baud).toBeEqual(250_000);
		harness.fake.sent();
	});

	it('warns when the scope kept another threshold than the one requested', async () => {
		harness.fake.replies.set(':DECode:BUS1:IIC:SCLThreshold?', '2.50E+00');
		try {
			const result = payload(
				await call(harness, 'configure_decode', { bus: 1, protocol: 'IIC', clock_threshold: 1.5 }),
			);
			expect(mentions(result, 'clock_threshold')).toBeTruthy();
		} finally {
			harness.fake.replies.set(':DECode:BUS1:IIC:SCLThreshold?', '1.50E+00');
			harness.fake.sent();
		}
	});

	it('writes the exact mnemonic of every protocol it owns', async () => {
		const cases: Array<[Record<string, unknown>, string[]]> = [
			[
				{ bus: 1, protocol: 'CAN', source: 'C1', threshold: 1.5, baud: '500kbps' },
				[':DECode:BUS1:CAN:SOURce C1', ':DECode:BUS1:CAN:THReshold 1.50E+00', ':DECode:BUS1:CAN:BAUD 500kbps'],
			],
			[
				{ bus: 1, protocol: 'LIN', source: 'D2', baud: 4800 },
				[':DECode:BUS1:LIN:SOURce D2', ':DECode:BUS1:LIN:BAUD CUSTom,4800'],
			],
			[{ bus: 1, protocol: 'FLEXray', baud: '10Mbps' }, [':DECode:BUS1:FLEXray:BAUD 10Mbps']],
			[
				{ bus: 2, protocol: 'CANFd', baud: '250kbps', data_baud: '2Mbps' },
				[':DECode:BUS2:CANFd:BAUDNominal 250kbps', ':DECode:BUS2:CANFd:BAUDData 2Mbps'],
			],
			[
				{ bus: 1, protocol: 'IIS', audio_variant: 'I2S', left_level: 'LOW', annotate: 'ALL', start_bit: 0 },
				[
					':DECode:BUS1:IIS:AVARiant I2S',
					':DECode:BUS1:IIS:LCH LOW',
					':DECode:BUS1:IIS:ANNotate ALL',
					':DECode:BUS1:IIS:SBIT 0',
				],
			],
			[
				{ bus: 1, protocol: 'M1553', source: 'C1', upper_threshold: 2, lower_threshold: 1 },
				[
					':DECode:BUS1:M1553:SOURce C1',
					':DECode:BUS1:M1553:UTHReshold 2.00E+00',
					':DECode:BUS1:M1553:LTHReshold 1.00E+00',
				],
			],
			[
				{ bus: 1, protocol: 'SENT', clock_period: 1e-6, crc_2010: true },
				[':DECode:BUS1:SENT:CRC ON', ':DECode:BUS1:SENT:CLOCk 1.00E-06'],
			],
			[
				{ bus: 1, protocol: 'MANchester', baud: 9600, data_size: 32 },
				[':DECode:BUS1:MANChester:BAUD 9600', ':DECode:BUS1:MANChester:DSIZe 32'],
			],
		];
		for (const [args, lines] of cases) {
			const bus = args.bus as number;
			const result = payload(await call(harness, 'configure_decode', args));
			expect(result.commands).toBeEqual([`:DECode:BUS${bus}:PROTocol ${args.protocol}`, ...lines]);
			harness.fake.sent();
		}
	});

	it('refuses a digital line on the one bus the guide gives none', async () => {
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, protocol: 'M1553', source: 'D0' });
	});

	it('sends nothing for a parameter the selected protocol does not have', async () => {
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, protocol: 'IIC', baud: 9600 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, clock_source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, protocol: 'SPI', data_length: 64 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 3, enabled: true });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, list_lines: 4, list_scroll: 6 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, enabled: true, unknown_key: 1 });
		await assertInvalidSendsNothing(harness, 'configure_decode', { bus: 1, protocol: 'IIC', clock_source: 'C9' });
	});

	it('returns the decoded frames as a bounded slice with the header as its columns', async () => {
		const result = payload(await call(harness, 'read_decode_result', { bus: 1, first_frame: 1, max_frames: 1 }));
		expect(result.columns).toBeEqual(['iic', 'address', 'rw', 'data']);
		expect(result.frames).toBeEqual({ total: 3, returned: 1, first: 1, truncated: true });
		expect(result.rows).toBeEqual([{ iic: '0x50', address: 'R', rw: '0', data: '0x56' }]);
		expect(result.protocol).toBe('IIC');
		expect(result.format).toBe('HEX');
		assertSent(harness.fake, [
			':DECode?',
			':DECode:BUS1?',
			':DECode:BUS1:PROTocol?',
			':DECode:BUS1:FORMat?',
			':DECode:BUS1:RESult?',
		]);
		await assertReadOnly(harness.client, 'read_decode_result');
	});

	it('never asks a bus that decodes nothing for its result', async () => {
		harness.fake.replies.set(':DECode:BUS1?', 'OFF');
		try {
			const result = await call(harness, 'read_decode_result', { bus: 1 });
			expect(result.isError).toBe(true);
			assertSent(harness.fake, [':DECode?', ':DECode:BUS1?']);
		} finally {
			harness.fake.replies.set(':DECode:BUS1?', 'ON');
		}
	});

	it('warns when the list answers column names and no frame', async () => {
		harness.fake.replies.set(':DECode:BUS1:RESult?', 'iic,address,rw,data;');
		try {
			const result = payload(await call(harness, 'read_decode_result', { bus: 1 }));
			expect(result.rows).toBeEqual([]);
			expect(mentions(result, 'no decoded frames')).toBeTruthy();
		} finally {
			harness.fake.replies.set(
				':DECode:BUS1:RESult?',
				'iic,address,rw,data;0x50,W,1,0x12;0x50,R,0,0x56;0x51,W,1,0x78;',
			);
			harness.fake.sent();
		}
	});

	it('keeps a frame whose field count does not match the header as raw text', async () => {
		harness.fake.replies.set(':DECode:BUS1:RESult?', 'iic,address,rw,data;0x50,W;');
		try {
			const result = payload(await call(harness, 'read_decode_result', { bus: 1 }));
			expect(result.rows).toBeEqual([{ raw: '0x50,W' }]);
		} finally {
			harness.fake.replies.set(
				':DECode:BUS1:RESult?',
				'iic,address,rw,data;0x50,W,1,0x12;0x50,R,0,0x56;0x51,W,1,0x78;',
			);
			harness.fake.sent();
		}
	});

	it('copies the settings between the bus and the trigger and says the line has no query', async () => {
		const result = payload(await call(harness, 'copy_decode_settings', { bus: 2, direction: 'TOTRigger' }));
		expect(result.commands).toBeEqual([':DECode:BUS2:COPY TOTRigger']);
		expect(result.write_only).toBeEqual([':DECode:BUS<n>:COPY']);
		assertSent(harness.fake, [':DECode:BUS2:COPY TOTRigger']);
		const { tools } = await harness.client.listTools();
		expect(tools.find(({ name }) => name === 'copy_decode_settings')?.annotations?.destructiveHint).toBe(true);
		await assertInvalidSendsNothing(harness, 'copy_decode_settings', { bus: 1, direction: 'BOTH' });
	});

	it('refuses a channel the model does not have', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			const result = await call(two, 'configure_decode', { bus: 1, protocol: 'IIC', clock_source: 'C4' });
			expect(result.isError).toBe(true);
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
