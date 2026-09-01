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
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const all = 'WGEN OUTP,OFF,WVTP,SINE,FREQ,1000HZ,AMPL,2V,OFST,0V,LOAD,HZ';

const replies: Record<string, string> = {
	'*IDN?': 'Siglent Technologies,SDS2104X,SDS2X0001,1.2.3',
	'PROD? MODEL': 'PROD MODEL,SDS2000X',
	'PROD? BAND': 'PROD BAND,25MHz',
	'STL? DEBUG':
		'STL M0,SINE,M1,NOISE,M2,CARDIAC,M3,GAUS_PULSE,M4,EXP_RISE,M5,EXP_FALL,M6,EMPTY,M7,EMPTY,M8,EMPTY,M9,EMPTY',
	'STL? RELEASE': 'STL M6,EMPTY,M7,EMPTY,M8,EMPTY,M9,EMPTY',
	'WGEN? ALL': all,
	'WGEN? OUTP': 'WGEN OUTP,OFF',
	'WVPR? M0': 'WVPR POS,M0,WVNM,SINE,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
	'WVPR? M1': 'WVPR POS,M1,WVNM,NOISE,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
	'WVPR? M2': 'WVPR POS,M2,WVNM,CARDIAC,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
	'WVPR? M3': 'WVPR POS,M3,WVNM,GAUS_PULSE,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
	'WVPR? M4': 'WVPR POS,M4,WVNM,EXP_RISE,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
	'WVPR? M5': 'WVPR POS,M5,WVNM,EXP_FALL,FREQ,1.000000e+03,AMPL,6.000000e+00,OFST,0.000000e+00',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

type Result = Awaited<ReturnType<Harness['client']['callTool']>>;

// Every call to this family collects the same "AWG option unknown" warning; the tests below assert what is left.
const warnings = (result: Result): string[] =>
	((payload(result).warnings as string[] | undefined) ?? []).filter((warning) => !warning.includes('awg'));

const answer = async (harness: Harness, query: string, reply: string, run: () => Promise<void>) => {
	harness.fake.replies.set(query, reply);
	try {
		await run();
	} finally {
		harness.fake.replies.set(query, replies[query] ?? '');
	}
};

describe('waveform generator tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the product, the parameters, the store list and the stored waveforms', async () => {
		harness.fake.sent();
		const result = await call(harness, 'get_waveform_generator');
		const state = payload(result);
		assertSent(harness.fake, [
			'PROD? MODEL',
			'PROD? BAND',
			'WGEN? ALL',
			'STL? DEBUG',
			'WVPR? M0',
			'WVPR? M1',
			'WVPR? M2',
			'WVPR? M3',
			'WVPR? M4',
			'WVPR? M5',
		]);
		expect(state.product).toBeEqual({
			model: 'SDS2000X',
			bandwidth: { value: 25e6, unit: 'Hz', raw: '25MHz' },
			raw: { model: 'PROD MODEL,SDS2000X', bandwidth: 'PROD BAND,25MHz' },
		});
		expect((state.state as Record<string, unknown>).output).toBe(false);
		expect((state.state as Record<string, unknown>).type).toBe('SINE');
		expect((state.state as Record<string, unknown>).frequency).toBeEqual({ value: 1000, unit: 'Hz', raw: '1000HZ' });
		expect((state.state as Record<string, unknown>).load).toBe('HZ');
		expect((state.stored as { entries: unknown[] }).entries.slice(0, 2)).toBeEqual([
			{ index: 'M0', name: 'SINE' },
			{ index: 'M1', name: 'NOISE' },
		]);
		expect((state.arbitrary as Array<Record<string, unknown>>)[0]).toBeEqual({
			location: 'M0',
			name: 'SINE',
			frequency: { value: 1000, raw: '1.000000e+03' },
			amplitude: { value: 6, raw: '6.000000e+00' },
			offset: { value: 0, raw: '0.000000e+00' },
			raw: replies['WVPR? M0'],
		});
		expect(state.write_only).toBeEqual(['ARWV']);
		assertUnknownWarning(result, 'awg');
		await assertReadOnly(harness.client, 'get_waveform_generator');
	});

	it('reads only the named stored waveforms and the requested store list', async () => {
		harness.fake.sent();
		await call(harness, 'get_waveform_generator', { store: 'RELEASE', waveforms: ['M0', 'M5'] });
		assertSent(harness.fake, ['PROD? MODEL', 'PROD? BAND', 'WGEN? ALL', 'STL? RELEASE', 'WVPR? M0', 'WVPR? M5']);
	});

	it('sends one WGEN command in the guide parameter order and reads the state back', async () => {
		await answer(harness, 'WGEN? ALL', 'WGEN OUTP,OFF,WVTP,SQUARE,FREQ,10000HZ,AMPL,2.5V,DUTY,45,LOAD,HZ', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', {
				waveform: { type: 'SQUARE', frequency: '10000Hz', amplitude: '2.5V', duty: 45 },
			});
			const command = 'WGEN WVTP,SQUARE,FREQ,10000Hz,AMPL,2.5V,DUTY,45%';
			expect(payload(result).commands).toBeEqual([command]);
			assertSent(harness.fake, ['WGEN? OUTP', command, 'WGEN? ALL']);
			expect(payload(result).type_parameter).toBe('WVTP');
			expect(warnings(result)).toBeEqual([]);
		});
	});

	it('sends the whole line again under the example spelling when WGEN? ALL answers TYPE', async () => {
		await answer(harness, 'WGEN? ALL', 'WGEN OUTP,OFF,TYPE,SQUARE,FREQ,10000HZ,AMPL,2.5V,DUTY,45,LOAD,HZ', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', {
				waveform: { type: 'SQUARE', frequency: '10000Hz', amplitude: '2.5V', duty: 45 },
			});
			const syntax = 'WGEN WVTP,SQUARE,FREQ,10000Hz,AMPL,2.5V,DUTY,45%';
			const example = 'WGEN TYPE,SQUARE,FREQ,10000Hz,AMPL,2.5V,DUTY,45%';
			assertSent(harness.fake, ['WGEN? OUTP', syntax, 'WGEN? ALL', example, 'WGEN? ALL']);
			expect(payload(result).commands).toBeEqual([syntax, example]);
			expect(payload(result).type_parameter).toBe('TYPE');
			expect(warnings(result).some((warning) => /sent again with that spelling/.test(warning))).toBeTruthy();
		});
	});

	it('reports the spelling as unknown when the read-back names no waveform type', async () => {
		await answer(harness, 'WGEN? ALL', 'WGEN OUTP,OFF,LOAD,HZ', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', { waveform: { type: 'SINE' } });
			assertSent(harness.fake, ['WGEN? OUTP', 'WGEN WVTP,SINE', 'WGEN? ALL']);
			expect(payload(result).type_parameter).toBe(undefined);
			expect(warnings(result).some((warning) => /waveform-type spelling.*unknown/.test(warning))).toBeTruthy();
		});
	});

	it('selects a stored arbitrary waveform before the parameters', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_waveform_generator', {
			arbitrary_index: 3,
			waveform: { type: 'ARB1', amplitude: '2V' },
			load: '50',
		});
		expect(payload(result).commands).toBeEqual(['ARWV INDEX,3', 'WGEN WVTP,ARB1,AMPL,2V,LOAD,50']);
		assertSent(harness.fake, ['WGEN? OUTP', 'ARWV INDEX,3', 'WGEN WVTP,ARB1,AMPL,2V,LOAD,50', 'WGEN? ALL']);
	});

	it('refuses to enable the output without the acknowledgement, and never writes', async () => {
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { output: true });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', {
			output: true,
			confirm_output_enable: false,
			waveform: { type: 'SINE' },
		});
	});

	it('enables the output last, reports what it drives and is annotated destructive', async () => {
		await answer(harness, 'WGEN? ALL', 'WGEN OUTP,ON,WVTP,SINE,FREQ,1000HZ,AMPL,2V,OFST,0V,LOAD,50', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', {
				waveform: { type: 'SINE', amplitude: '2V', offset: '0V' },
				load: '50',
				output: true,
				confirm_output_enable: true,
			});
			const state = payload(result);
			expect(state.commands).toBeEqual(['WGEN WVTP,SINE,AMPL,2V,OFST,0V,LOAD,50', 'WGEN OUTP,ON']);
			assertSent(harness.fake, ['WGEN WVTP,SINE,AMPL,2V,OFST,0V,LOAD,50', 'WGEN OUTP,ON', 'WGEN? ALL']);
			expect(state.output_enabled).toBeEqual({
				confirmed: true,
				type: 'SINE',
				amplitude: { value: 2, unit: 'V', raw: '2V' },
				offset: { value: 0, unit: 'V', raw: '0V' },
				load: '50',
			});
			expect(warnings(result)).toBeEqual([]);
		});

		const { tools } = await harness.client.listTools();
		const hints = tools.find((tool) => tool.name === 'configure_waveform_generator')?.annotations;
		expect(hints?.readOnlyHint).toBe(false);
		expect(hints?.destructiveHint).toBe(true);
	});

	it('switches the output off first, without an acknowledgement and without asking its state', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_waveform_generator', {
			output: false,
			waveform: { type: 'SINE', amplitude: '2V' },
		});
		expect(payload(result).commands).toBeEqual(['WGEN OUTP,OFF', 'WGEN WVTP,SINE,AMPL,2V']);
		assertSent(harness.fake, ['WGEN OUTP,OFF', 'WGEN WVTP,SINE,AMPL,2V', 'WGEN? ALL']);
		expect(payload(result).output_enabled).toBe(undefined);
	});

	it('refuses to change a live output without the acknowledgement, writing nothing', async () => {
		await answer(harness, 'WGEN? OUTP', 'WGEN OUTP,ON', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', { waveform: { type: 'DC', dc_offset: '1V' } });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(/output is already on.*confirm_output_enable/s);
			assertSent(harness.fake, ['WGEN? OUTP']);
		});
	});

	it('changes a live output once it is acknowledged, without asking its state', async () => {
		await answer(harness, 'WGEN? OUTP', 'WGEN OUTP,ON', async () => {
			harness.fake.sent();
			await call(harness, 'configure_waveform_generator', {
				waveform: { type: 'SINE', amplitude: '1V' },
				confirm_output_enable: true,
			});
			assertSent(harness.fake, ['WGEN WVTP,SINE,AMPL,1V', 'WGEN? ALL']);
		});
	});

	it('warns instead of guessing when the output state is unreadable', async () => {
		await answer(harness, 'WGEN? OUTP', 'WGEN OUTP,?', async () => {
			harness.fake.sent();
			const result = await call(harness, 'configure_waveform_generator', { load: 'HZ' });
			assertSent(harness.fake, ['WGEN? OUTP', 'WGEN LOAD,HZ', 'WGEN? ALL']);
			expect(
				warnings(result).some((warning) => warning.includes('without knowing whether the output was active')),
			).toBeTruthy();
		});
	});

	it('rejects parameters the guide does not allow for the waveform type, sending nothing', async () => {
		for (const waveform of [
			{ type: 'SINE', duty: 45 },
			{ type: 'SQUARE', symmetry: 50 },
			{ type: 'RAMP', width: '10US' },
			{ type: 'PULSE', duty: 45 },
			{ type: 'NOISE', frequency: '1000Hz' },
			{ type: 'NOISE', amplitude: '1V' },
			{ type: 'DC', frequency: '1000Hz' },
			{ type: 'DC', amplitude: '1V' },
			{ type: 'SINE', dc_offset: '1V' },
			{ type: 'SINE', stdev: '0.2V' },
			{ type: 'TRIANGLE' },
		]) {
			await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { waveform });
		}
	});

	it('rejects values outside the guide ranges, sending nothing', async () => {
		for (const waveform of [
			{ type: 'SINE', frequency: '30MHz' },
			{ type: 'SINE', frequency: '1Hz;WGEN OUTP,ON' },
			{ type: 'SINE', frequency: '2V' },
			{ type: 'SINE', amplitude: '7V' },
			{ type: 'SINE', amplitude: '1MV' },
			{ type: 'SINE', offset: '4V' },
			{ type: 'SINE', amplitude: '4V', offset: '2V' },
			{ type: 'DC', dc_offset: '4V' },
			{ type: 'SQUARE', duty: 90 },
			{ type: 'RAMP', symmetry: 101 },
			{ type: 'PULSE', width: '2MS' },
			{ type: 'PULSE', width: '10NS' },
			{ type: 'NOISE', stdev: '0.5V' },
			{ type: 'NOISE', stdev: '0.4V', mean: '1V' },
		]) {
			await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { waveform });
		}
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { arbitrary_index: 10 });
		await assertInvalidSendsNothing(harness, 'configure_waveform_generator', { load: '1M' });
		await assertInvalidSendsNothing(harness, 'get_waveform_generator', { waveforms: ['M10'] });
	});

	it('accepts the amplitude-dependent offset the guide allows', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_waveform_generator', {
			waveform: { type: 'SINE', amplitude: '4V', offset: '1V' },
		});
		expect(payload(result).commands).toBeEqual(['WGEN WVTP,SINE,AMPL,4V,OFST,1V']);
	});

	it('refuses an empty request', async () => {
		const result = await call(harness, 'configure_waveform_generator');
		expect(result.isError).toBe(true);
		expect(text(result)).toMatchRegex(/at least one setting/);
	});

	it('warns about a value the scope did not take', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_waveform_generator', {
			waveform: { type: 'SINE', amplitude: '2.5V' },
		});
		expect(warnings(result).some((warning) => warning.startsWith('amplitude was set to "2.5V"'))).toBeTruthy();
	});

	it('reads the waveform type back in the example spelling as well as the syntax one', async () => {
		await answer(harness, 'WGEN? ALL', 'WGEN OUTP,OFF,TYPE,RAMP,SYMM,50', async () => {
			const state = payload(await call(harness, 'get_waveform_generator', { waveforms: [] }));
			expect((state.state as Record<string, unknown>).type).toBe('RAMP');
			expect((state.state as Record<string, unknown>).symmetry).toBeEqual({ value: 50, raw: '50' });
		});
	});

	it('never sends an index the scope invented into the next query', async () => {
		await answer(harness, 'STL? DEBUG', 'STL M0,SINE,M1 ;WGEN OUTP,SINE', async () => {
			harness.fake.sent();
			await call(harness, 'get_waveform_generator');
			assertSent(harness.fake, ['PROD? MODEL', 'PROD? BAND', 'WGEN? ALL', 'STL? DEBUG', 'WVPR? M0']);
		});
	});

	it('refuses the families the guide lists without the AWG option, writing nothing', async () => {
		const older = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS1104X-E,SDS1X0001,1.2.3' });
		try {
			await older.client.callTool({ name: 'identify', arguments: {} });
			older.fake.sent();
			assertCapabilityError(
				await older.client.callTool({ name: 'get_waveform_generator', arguments: {} }),
				'SDS1104X-E',
			);
			assertCapabilityError(
				await older.client.callTool({
					name: 'configure_waveform_generator',
					arguments: { output: false },
				}),
				'SDS1104X-E',
			);
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('refuses the newer SCPI dialect', async () => {
		const newer = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2504X HD,SDS2X0001,1.2.3' });
		try {
			assertCapabilityError(
				await newer.client.callTool({ name: 'get_waveform_generator', arguments: {} }),
				'SDS2504X HD',
			);
			expect(newer.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await newer.close();
		}
	});
});
