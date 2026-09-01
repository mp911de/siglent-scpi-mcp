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

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':CHANnel:REFerence?': 'OFFSet',
	':CHANnel1:SWITch?': 'ON',
	':CHANnel1:UNIT?': 'V',
	':CHANnel1:IMPedance?': 'ONEMeg',
	':CHANnel1:PROBe?': '1.00E+01',
	':CHANnel1:SCALe?': '5.00E-01',
	':CHANnel1:OFFSet?': '-3.80E+00',
	':CHANnel1:COUPling?': 'DC',
	':CHANnel1:BWLimit?': '20M',
	':CHANnel1:INVert?': 'OFF',
	':CHANnel1:SKEW?': '1.52E-09',
	':CHANnel1:LABel:TEXT?': '"VOUT"',
	':CHANnel1:LABel?': 'ON',
	':CHANnel1:VISible?': 'ON',
};

const queries = Object.keys(replies).filter((line) => line.startsWith(':CHANnel1'));

describe('EN11F channel tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole channel and the scope-wide vertical reference', async () => {
		const state = payload(await call(harness, 'get_channel', { source: 'C1' }));
		expect(state).toBeEqual({
			channel: 'C1',
			trace: true,
			unit: 'V',
			impedance: 'ONEMeg',
			probe_attenuation: { value: 10, raw: '1.00E+01' },
			volts_per_div: { value: 0.5, raw: '5.00E-01' },
			offset: { value: -3.8, raw: '-3.80E+00' },
			coupling: 'DC',
			bandwidth_limit: '20M',
			inverted: false,
			skew: { value: 1.52e-9, raw: '1.52E-09' },
			label_text: 'VOUT',
			label: true,
			visible: true,
			vertical_reference: 'OFFSet',
		});
		assertSent(harness.fake, [...queries, ':CHANnel:REFerence?']);
		await assertReadOnly(harness.client, 'get_channel');
	});

	it('accepts channel as an alias of source', async () => {
		expect(payload(await call(harness, 'get_channel', { channel: 'C1' })).channel).toBe('C1');
		harness.fake.sent();
	});

	it('sends the reference, the probe factor and the scale before what they bound', async () => {
		const result = payload(
			await call(harness, 'configure_channel', {
				source: 'C1',
				vertical_reference: 'OFFSet',
				trace: true,
				unit: 'V',
				impedance: 'ONEMeg',
				probe_attenuation: 10,
				volts_per_div: 0.5,
				offset: -3.8,
				coupling: 'DC',
				bandwidth_limit: '20M',
				inverted: false,
				skew: 1.52e-9,
				label_text: 'VOUT',
				label: true,
				visible: true,
			}),
		);
		const written = [
			':CHANnel:REFerence OFFSet',
			':CHANnel1:SWITch ON',
			':CHANnel1:UNIT V',
			':CHANnel1:IMPedance ONEMeg',
			':CHANnel1:PROBe VALue,1.00E+01',
			':CHANnel1:SCALe 5.00E-01',
			':CHANnel1:OFFSet -3.80E+00',
			':CHANnel1:COUPling DC',
			':CHANnel1:BWLimit 20M',
			':CHANnel1:INVert OFF',
			':CHANnel1:SKEW 1.52E-09',
			':CHANnel1:LABel:TEXT "VOUT"',
			':CHANnel1:LABel ON',
			':CHANnel1:VISible ON',
		];
		expect(result.commands).toBeEqual(written);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [...written, ...queries, ':CHANnel:REFerence?']);
	});

	it('reads back only what it set', async () => {
		const result = payload(await call(harness, 'configure_channel', { source: 'C1', volts_per_div: 0.5 }));
		expect(result.commands).toBeEqual([':CHANnel1:SCALe 5.00E-01']);
		expect(result.state).toBeEqual({ channel: 'C1', volts_per_div: { value: 0.5, raw: '5.00E-01' } });
		assertSent(harness.fake, [':CHANnel1:SCALe 5.00E-01', ':CHANnel1:SCALe?']);
	});

	it('warns when the scope moved a value it could not take', async () => {
		const result = payload(await call(harness, 'configure_channel', { source: 'C1', offset: 12 }));
		expect((result.warnings as string[]).some((warning) => warning.includes('offset'))).toBeTruthy();
		harness.fake.sent();
	});

	it('sends nothing for a channel setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_channel', { volts_per_div: 0.5 });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C5', volts_per_div: 0.5 });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', coupling: 'A1M' });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', bandwidth_limit: true });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', impedance: '50' });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', skew: 2e-7 });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', probe_attenuation: 1e7 });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', label_text: 'a"b' });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', label_text: 'x'.repeat(21) });
		await assertInvalidSendsNothing(harness, 'configure_channel', { source: 'C1', trace: 'ON' });
		await assertInvalidSendsNothing(harness, 'get_channel', {});
		await assertInvalidSendsNothing(harness, 'get_channel', { source: 'C1', extra: 1 });
	});
});

describe('EN11F channel gate', () => {
	it('refuses a channel the model does not have', async () => {
		const harness = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(harness, 'identify');
			harness.fake.sent();
			assertCapabilityError(await call(harness, 'get_channel', { source: 'C3' }), 'SDS802X HD');
			assertSent(harness.fake, []);
		} finally {
			await harness.close();
		}
	});
});
