import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	'C1:ARbWaVe?': 'C1:ARWV INDEX,2,NAME,StairUp',
	'C1:BaSic_WaVe?': 'C1:BSWV WVTP,SINE,FRQ,1000HZ,PERI,0.001S,AMP,2V,OFST,0V,HLEV,1V,LLEV,-1V,PHSE,0',
	'C1:OUTPut?': 'C1:OUTP OFF,LOAD,50,PLRT,NOR',
	'C1:SYNC?': 'C1:SYNC ON,TYPE,CH1',
	'VOLTPRT?': 'VOLTPRT ON',
	'SToreList?': 'STL M10, ExpFal, M2, StairUp',
	'SToreList? USER': 'STL M50, wave_1',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F waveform generator tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads every section of the generator without a leading colon on any of them', async () => {
		const state = payload(await call(harness, 'get_waveform_generator'));
		expect(state.waveform).toBeEqual({
			type: 'SINE',
			frequency: { value: 1000, unit: 'Hz', raw: '1000HZ' },
			period: { value: 0.001, unit: 'S', raw: '0.001S' },
			amplitude: { value: 2, unit: 'V', raw: '2V' },
			offset: { value: 0, unit: 'V', raw: '0V' },
			raw: replies['C1:BaSic_WaVe?'],
		});
		expect(state.output).toBeEqual({
			output: false,
			load: '50',
			polarity: 'NOR',
			raw: replies['C1:OUTPut?'],
		});
		expect(state.sync).toBeEqual({ sync: true, sync_source: 'CH1', raw: replies['C1:SYNC?'] });
		expect(state.voltage_protection).toBe(true);
		expect(state.stored).toBeEqual({
			entries: [
				{ index: 'M10', name: 'ExpFal' },
				{ index: 'M2', name: 'StairUp' },
			],
		});
		assertSent(harness.fake, ['C1:BaSic_WaVe?', 'C1:OUTPut?', 'C1:ARbWaVe?', 'C1:SYNC?', 'VOLTPRT?', 'SToreList?']);
		await assertReadOnly(harness.client, 'get_waveform_generator');
	});

	it('narrows the stored list to the location the request names', async () => {
		const state = payload(await call(harness, 'get_waveform_generator', { store: 'USER' }));
		expect(state.stored).toBeEqual({ store: 'USER', entries: [{ index: 'M50', name: 'wave_1' }] });
		expect(warnings(state).some((warning) => warning.includes('Option FG'))).toBeTruthy();
		harness.fake.sent();
	});

	it('reports an empty store rather than an empty list', async () => {
		harness.fake.replies.set('SToreList?', 'STL EMPTY');
		const state = payload(await call(harness, 'get_waveform_generator'));
		expect(state.stored).toBeEqual({ empty: true });
		harness.fake.replies.set('SToreList?', replies['SToreList?'] as string);
		harness.fake.sent();
	});

	it('shapes the wave before it drives the output, and protects it before that', async () => {
		const result = payload(
			await call(harness, 'configure_waveform_generator', {
				type: 'SQUARE',
				frequency: 2000,
				amplitude: 3,
				duty: 45,
				load: 'HZ',
				sync: true,
				voltage_protection: true,
				output: true,
				confirm_output_enable: true,
			}),
		);
		expect(result.commands).toBeEqual([
			'C1:BaSic_WaVe WVTP,SQUARE,FRQ,2000,AMP,3,DUTY,45',
			'C1:SYNC ON',
			'VOLTPRT ON',
			'C1:OUTPut ON,LOAD,HZ',
		]);
		assertSent(harness.fake, [
			'C1:BaSic_WaVe WVTP,SQUARE,FRQ,2000,AMP,3,DUTY,45',
			'C1:SYNC ON',
			'VOLTPRT ON',
			'C1:OUTPut ON,LOAD,HZ',
			'C1:BaSic_WaVe?',
			'C1:OUTPut?',
			'C1:SYNC?',
			'VOLTPRT?',
		]);
	});

	it('switches the output off first and needs no acknowledgement for it', async () => {
		const result = payload(await call(harness, 'configure_waveform_generator', { output: false, amplitude: 1 }));
		expect(result.commands).toBeEqual(['C1:OUTPut OFF', 'C1:BaSic_WaVe AMP,1']);
		assertSent(harness.fake, ['C1:OUTPut OFF', 'C1:BaSic_WaVe AMP,1', 'C1:BaSic_WaVe?', 'C1:OUTPut?']);
	});

	it('refuses to change a live output without the acknowledgement, after asking whether it is live', async () => {
		harness.fake.replies.set('C1:OUTPut?', 'C1:OUTP ON,LOAD,50,PLRT,NOR');
		const result = await call(harness, 'configure_waveform_generator', { amplitude: 1 });
		expect(result.isError).toBe(true);
		expect(String(payload(result).error)).toMatchRegex(/already on/);
		assertSent(harness.fake, ['C1:OUTPut?']);
		harness.fake.replies.set('C1:OUTPut?', replies['C1:OUTPut?'] as string);
	});

	it('reconfigures a generator whose output state it cannot read, and says so', async () => {
		harness.fake.replies.set('C1:OUTPut?', 'C1:OUTP ****');
		const result = payload(await call(harness, 'configure_waveform_generator', { amplitude: 1 }));
		expect(result.commands).toBeEqual(['C1:BaSic_WaVe AMP,1']);
		expect(warnings(result).some((warning) => warning.includes('rather than ON or OFF'))).toBeTruthy();
		harness.fake.replies.set('C1:OUTPut?', replies['C1:OUTPut?'] as string);
		harness.fake.sent();
	});

	it('selects an arbitrary waveform by index or by name', async () => {
		const byIndex = payload(
			await call(harness, 'configure_waveform_generator', { arbitrary_index: 2, confirm_output_enable: true }),
		);
		expect(byIndex.commands).toBeEqual(['C1:ARbWaVe INDEX,2']);
		expect(byIndex.state).toBeEqual({ arbitrary: { index: '2', name: 'StairUp' } });
		const byName = payload(
			await call(harness, 'configure_waveform_generator', { arbitrary_name: 'wave_1', confirm_output_enable: true }),
		);
		expect(byName.commands).toBeEqual(['C1:ARbWaVe NAME,wave_1']);
	});

	it('warns that the output is no longer protected when protection goes off', async () => {
		const result = payload(
			await call(harness, 'configure_waveform_generator', {
				voltage_protection: false,
				confirm_output_enable: true,
			}),
		);
		expect(result.commands).toBeEqual(['VOLTPRT OFF']);
		expect(warnings(result).some((warning) => warning.includes('no longer protected'))).toBeTruthy();
	});

	it('warns when the generator did not take a value', async () => {
		const result = payload(
			await call(harness, 'configure_waveform_generator', { amplitude: 5, confirm_output_enable: true }),
		);
		expect(warnings(result).some((warning) => warning.includes('amplitude was set to 5'))).toBeTruthy();
	});

	it('sends nothing for a request the guide does not document', async () => {
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', {});
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { output: true });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { type: 'TRIANGLE' });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { type: 'SINE', duty: 45 });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { type: 'NOISE', frequency: 1000 });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', {
			arbitrary_index: 1,
			arbitrary_name: 'wave_1',
		});
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { arbitrary_name: 'wave 1;' });
		await assertInvalidSendsNothing(harness, 'get_waveform_generator', { store: 'ALL' });
	});
});
