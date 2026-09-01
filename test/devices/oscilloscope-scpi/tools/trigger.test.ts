import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';
import { readBacks, serialTriggers } from '../serial-triggers.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':TRIGger:MODE?': 'NORMal',
	':TRIGger:STATus?': "Trig'd",
	':TRIGger:FREQuency?': '1.234561E+04',
	':TRIGger:TYPE?': 'EDGE',
	':TRIGger:EDGE:SOURce?': 'C1',
	':TRIGger:EDGE:IMPedance?': 'ONEMeg',
	':TRIGger:EDGE:SLOPe?': 'RISing',
	':TRIGger:EDGE:LEVel?': '5.00E-01',
	':TRIGger:EDGE:COUPling?': 'DC',
	':TRIGger:EDGE:NREJect?': 'OFF',
	':TRIGger:EDGE:HLDEVent?': '3',
	':TRIGger:EDGE:HLDTime?': '1.50E-08',
	':TRIGger:EDGE:HOLDoff?': 'TIME',
	':TRIGger:EDGE:HSTart?': 'LAST_TRIG',
	':TRIGger:RUNT:SOURce?': 'C2',
	':TRIGger:RUNT:POLarity?': 'NEGative',
	':TRIGger:RUNT:HLEVel?': '5.00E-01',
	':TRIGger:RUNT:LLEVel?': '-5.00E-01',
	':TRIGger:RUNT:LIMit?': 'INNer',
	':TRIGger:RUNT:TLOWer?': '1.00E-08',
	':TRIGger:RUNT:TUPPer?': '3.00E-08',
	':TRIGger:VIDeo:SOURce?': 'C1',
	':TRIGger:VIDeo:STANdard?': 'NTSC',
	':TRIGger:VIDeo:FRATe?': '50Hz',
	':TRIGger:VIDeo:LCNT?': '800',
	':TRIGger:VIDeo:FCNT?': '8',
	':TRIGger:VIDeo:INTerlace?': '8',
	':TRIGger:VIDeo:LEVel?': '5.00E-01',
	':TRIGger:VIDeo:SYNC?': 'SELect',
	':TRIGger:VIDeo:FIELd?': '2',
	':TRIGger:VIDeo:LINE?': '100',
	':TRIGger:PATTern:INPut?': 'H,L,X,X',
	':TRIGger:PATTern:LOGic?': 'AND',
	':TRIGger:QUALified:TYPE?': 'EDGE,RISing',
	':TRIGger:QUALified:ESource?': 'C1',
};

const edgeQueries = Object.keys(replies).filter((line) => line.startsWith(':TRIGger:EDGE'));

describe('EN11F trigger tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the top level and the parameters of the selected type alone', async () => {
		const state = payload(await call(harness, 'get_trigger'));
		expect(state).toBeEqual({
			mode: 'NORMal',
			status: "Trig'd",
			frequency: { value: 12345.61, raw: '1.234561E+04' },
			type: 'EDGE',
			source: 'C1',
			impedance: 'ONEMeg',
			slope: 'RISing',
			level: { value: 0.5, raw: '5.00E-01' },
			coupling: 'DC',
			noise_reject: false,
			holdoff_events: 3,
			holdoff_time: { value: 1.5e-8, raw: '1.50E-08' },
			holdoff: 'TIME',
			holdoff_start: 'LAST_TRIG',
		});
		assertSent(harness.fake, [
			':TRIGger:MODE?',
			':TRIGger:STATus?',
			':TRIGger:FREQuency?',
			':TRIGger:TYPE?',
			...edgeQueries,
		]);
		await assertReadOnly(harness.client, 'get_trigger');
	});

	it('leaves a type outside the guide, and one it documents no parameter for, unread', async () => {
		harness.fake.replies.set(':TRIGger:TYPE?', 'PROFIbus');
		const unknown = payload(await call(harness, 'get_trigger'));
		expect(unknown.type).toBeEqual({ raw: 'PROFIbus' });
		expect((unknown.warnings as string[]).some((warning) => warning.includes('PROFIbus'))).toBeTruthy();
		assertSent(harness.fake, [':TRIGger:MODE?', ':TRIGger:STATus?', ':TRIGger:FREQuency?', ':TRIGger:TYPE?']);

		harness.fake.replies.set(':TRIGger:TYPE?', 'M1553');
		const bare = payload(await call(harness, 'get_trigger'));
		expect(bare.type).toBe('M1553');
		expect(bare.warnings).toBe(undefined);
		assertSent(harness.fake, [':TRIGger:MODE?', ':TRIGger:STATus?', ':TRIGger:FREQuency?', ':TRIGger:TYPE?']);
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
	});

	it('spells the mnemonics of each serial protocol and queries back only what the guide answers', async () => {
		harness.fake.fallback = (line) => (line.endsWith('?') ? '0' : undefined);
		try {
			for (const serial of serialTriggers) {
				const result = payload(await call(harness, 'configure_trigger', serial.input));
				expect(result.commands).toBeEqual(serial.commands);
				assertSent(harness.fake, [...serial.commands, ...readBacks(serial)]);
			}
		} finally {
			harness.fake.fallback = undefined;
		}
	});

	it('warns about optional serial features and types without configurable parameters', async () => {
		harness.fake.fallback = (line) => (line.endsWith('?') ? '0' : undefined);
		try {
			const optional = payload(await call(harness, 'configure_trigger', { type: 'IIS', condition: 'MUTE' }));
			expect((optional.warnings as string[]).some((warning) => warning.includes('optional feature'))).toBeTruthy();
			const bare = payload(await call(harness, 'configure_trigger', { type: 'ARINC429' }));
			expect(
				(bare.warnings as string[]).some((warning) => warning.includes('no configurable parameters')),
			).toBeTruthy();
		} finally {
			harness.fake.fallback = undefined;
			harness.fake.sent();
		}
	});

	it('selects the type first and sends its parameters in guide order as NR3', async () => {
		harness.fake.replies.set(':TRIGger:TYPE?', 'RUNT');
		const result = payload(
			await call(harness, 'configure_trigger', {
				type: 'RUNT',
				source: 'C2',
				polarity: 'NEGative',
				level_high: 0.5,
				level_low: -0.5,
				limit: 'INNer',
				time_lower: 1e-8,
				time_upper: 3e-8,
			}),
		);
		expect(result.commands).toBeEqual([
			':TRIGger:TYPE RUNT',
			':TRIGger:RUNT:SOURce C2',
			':TRIGger:RUNT:POLarity NEGative',
			':TRIGger:RUNT:HLEVel 5.00E-01',
			':TRIGger:RUNT:LLEVel -5.00E-01',
			':TRIGger:RUNT:LIMit INNer',
			':TRIGger:RUNT:TLOWer 1.00E-08',
			':TRIGger:RUNT:TUPPer 3.00E-08',
		]);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			...(result.commands as string[]),
			':TRIGger:TYPE?',
			':TRIGger:RUNT:SOURce?',
			':TRIGger:RUNT:POLarity?',
			':TRIGger:RUNT:HLEVel?',
			':TRIGger:RUNT:LLEVel?',
			':TRIGger:RUNT:LIMit?',
			':TRIGger:RUNT:TLOWer?',
			':TRIGger:RUNT:TUPPer?',
		]);
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
	});

	it('reads back only what it set and warns about a level the scope moved', async () => {
		const result = payload(await call(harness, 'configure_trigger', { type: 'EDGE', level: 0.25 }));
		expect(result.commands).toBeEqual([':TRIGger:TYPE EDGE', ':TRIGger:EDGE:LEVel 2.50E-01']);
		expect(result.state).toBeEqual({ type: 'EDGE', level: { value: 0.5, raw: '5.00E-01' } });
		expect((result.warnings as string[]).some((warning) => warning.includes('level'))).toBeTruthy();
		assertSent(harness.fake, [
			':TRIGger:TYPE EDGE',
			':TRIGger:EDGE:LEVel 2.50E-01',
			':TRIGger:TYPE?',
			':TRIGger:EDGE:LEVel?',
		]);
	});

	it('asks for a video parameter of the custom standard only once the standard says so', async () => {
		harness.fake.replies.set(':TRIGger:TYPE?', 'VIDeo');
		const ntsc = payload(await call(harness, 'get_trigger'));
		expect(ntsc.standard).toBe('NTSC');
		expect(ntsc.frame_rate).toBe(undefined);
		expect(ntsc.line).toBeEqual(100);
		assertSent(harness.fake, [
			':TRIGger:MODE?',
			':TRIGger:STATus?',
			':TRIGger:FREQuency?',
			':TRIGger:TYPE?',
			':TRIGger:VIDeo:SOURce?',
			':TRIGger:VIDeo:STANdard?',
			':TRIGger:VIDeo:LEVel?',
			':TRIGger:VIDeo:SYNC?',
			':TRIGger:VIDeo:FIELd?',
			':TRIGger:VIDeo:LINE?',
		]);

		harness.fake.replies.set(':TRIGger:VIDeo:STANdard?', 'CUSTom');
		const customised = payload(await call(harness, 'get_trigger'));
		expect(customised.frame_rate).toBe('50Hz');
		expect([customised.line_count, customised.field_count, customised.interlace]).toBeEqual([800, 8, 8]);
		assertSent(harness.fake, [
			':TRIGger:MODE?',
			':TRIGger:STATus?',
			':TRIGger:FREQuency?',
			':TRIGger:TYPE?',
			':TRIGger:VIDeo:SOURce?',
			':TRIGger:VIDeo:STANdard?',
			':TRIGger:VIDeo:FRATe?',
			':TRIGger:VIDeo:LCNT?',
			':TRIGger:VIDeo:FCNT?',
			':TRIGger:VIDeo:INTerlace?',
			':TRIGger:VIDeo:LEVel?',
			':TRIGger:VIDeo:SYNC?',
			':TRIGger:VIDeo:FIELd?',
			':TRIGger:VIDeo:LINE?',
		]);
		harness.fake.replies.set(':TRIGger:VIDeo:STANdard?', 'NTSC');
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
	});

	it('writes the per-source pattern and level as the one command each the guide prints', async () => {
		harness.fake.replies.set(':TRIGger:TYPE?', 'PATTern');
		const result = payload(
			await call(harness, 'configure_trigger', {
				type: 'PATTern',
				pattern: ['H', 'L', 'X', 'X'],
				channel_level: { source: 'C2', level: 0.5 },
				logic: 'AND',
			}),
		);
		expect(result.commands).toBeEqual([
			':TRIGger:TYPE PATTern',
			':TRIGger:PATTern:INPut H,L,X,X',
			':TRIGger:PATTern:LEVel C2,5.00E-01',
			':TRIGger:PATTern:LOGic AND',
		]);
		expect(result.state).toBeEqual({ type: 'PATTern', pattern: ['H', 'L', 'X', 'X'], logic: 'AND' });
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			...(result.commands as string[]),
			':TRIGger:TYPE?',
			':TRIGger:PATTern:INPut?',
			':TRIGger:PATTern:LOGic?',
		]);
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
	});

	it('writes the qualified type and its option as one command and reads both back', async () => {
		harness.fake.replies.set(':TRIGger:TYPE?', 'QUALified');
		const result = payload(
			await call(harness, 'configure_trigger', {
				type: 'QUALified',
				edge_source: 'C1',
				qualified_type: { state: 'EDGE', option: 'RISing' },
			}),
		);
		expect(result.commands).toBeEqual([
			':TRIGger:TYPE QUALified',
			':TRIGger:QUALified:ESource C1',
			':TRIGger:QUALified:TYPE EDGE,RISing',
		]);
		expect(result.state).toBeEqual({
			type: 'QUALified',
			edge_source: 'C1',
			qualified_type: { state: 'EDGE', option: 'RISing' },
		});
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
		harness.fake.sent();
	});

	it('warns that a digital source needs an option nothing reports', async () => {
		harness.fake.replies.set(':TRIGger:PULSe:SOURce?', 'D3');
		harness.fake.replies.set(':TRIGger:TYPE?', 'PULSE');
		const result = payload(await call(harness, 'configure_trigger', { type: 'PULSE', source: 'D3' }));
		expect((result.warnings as string[]).some((warning) => warning.includes('MSO'))).toBeTruthy();
		harness.fake.replies.set(':TRIGger:TYPE?', 'EDGE');
		harness.fake.sent();
	});

	it('sends the mode before the run or stop that has no query form', async () => {
		const result = payload(await call(harness, 'configure_trigger_mode', { mode: 'NORMal', action: 'run' }));
		expect(result.commands).toBeEqual([':TRIGger:MODE NORMal', ':TRIGger:RUN']);
		expect(result.state).toBeEqual({ mode: 'NORMal', status: "Trig'd" });
		assertSent(harness.fake, [':TRIGger:MODE NORMal', ':TRIGger:RUN', ':TRIGger:MODE?', ':TRIGger:STATus?']);
	});

	it('stops without touching the mode', async () => {
		const result = payload(await call(harness, 'configure_trigger_mode', { action: 'stop' }));
		expect(result.commands).toBeEqual([':TRIGger:STOP']);
		assertSent(harness.fake, [':TRIGger:STOP', ':TRIGger:STATus?']);
	});

	it('reports run control as changing what the scope captured', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find(({ name }) => name === 'configure_trigger_mode')?.annotations;
		expect(annotations).toBeEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it('sends nothing for a trigger setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger', {});
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', level_hi: 0.5 });
		await assertInvalidSendsNothing(harness, 'configure_trigger_mode', { mode: 'SINGle', run: true });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'PROFIbus' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'IIC', slope: 'RISing' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'IIC', address: 128 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'IIC', data_length: 96 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'SPI', data_pattern: ['1', 'H'] });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'SPI', cs_type: 1 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'SPI',
			data_length: 8,
			data_pattern: ['1', '0', '1', '0'],
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'CAN', id_length: '11BITS', id: 4096 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'UART', baud: 100 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'CAN', condition: 'BReak' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'FLEXray', repetition: 3 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'LIN', lin_standard: 2 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'M1553', source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', slope: 'BOTH' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'INTerval', slope: 'ALTernate' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'SLOPe', source: 'EX' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', window_type: 'ABSolute' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', impedance: 'FIFTy', source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'RUNT',
			level_high: -1,
			level_low: 1,
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'RUNT',
			limit: 'LESSthan',
			time_lower: 1e-8,
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', holdoff_time: 1e-9 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', holdoff_events: 0 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'VIDeo',
			standard: 'NTSC',
			frame_rate: '50Hz',
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'VIDeo', field: 3 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'VIDeo', line_count: 100 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'PATTern', logic: 'OR', limit: 'INNer' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'PATTern', pattern: ['H', 'Z'] });
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'QUALified',
			qualified_type: { state: 'EDGE', option: 'LOW' },
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', {
			type: 'DELay',
			channel_level: { source: 'D3', level: 0.5 },
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'NEDGe', edge_count: 0 });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'SHOLd', slope: 'ALTernate' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { type: 'EDGE', clock_source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_mode', {});
		await assertInvalidSendsNothing(harness, 'configure_trigger_mode', { mode: 'SINGLE_SHOT' });
	});

	it('refuses a channel the model does not have', async () => {
		const other = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(other, 'identify');
			other.fake.sent();
			assertCapabilityError(await call(other, 'configure_trigger', { type: 'SLOPe', source: 'C3' }), 'SDS802X HD');
			assertCapabilityError(
				await call(other, 'configure_trigger', { type: 'SHOLd', clock_source: 'C1', data_source: 'C4' }),
				'SDS802X HD',
			);
			assertSent(other.fake, []);
		} finally {
			await other.close();
		}
	});
});
