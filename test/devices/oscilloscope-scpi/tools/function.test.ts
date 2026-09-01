import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

const replies: Record<string, Reply> = {
	':FUNCtion1?': 'ON',
	':FUNCtion1:OPERation?': 'INTegrate',
	':FUNCtion1:SOURce1?': 'C1',
	':FUNCtion1:SOURce2?': 'C2',
	':FUNCtion1:INVert?': 'OFF',
	':FUNCtion1:SCALe?': '1.00E+00',
	':FUNCtion1:POSition?': '5.00E-01',
	':FUNCtion1:LABel?': 'ON',
	':FUNCtion1:LABel:TEXT?': '"MATH"',
	':FUNCtion1:AVERage:NUM?': '64',
	':FUNCtion1:FILTer:TYPe?': 'BPASs',
	':FUNCtion1:FILTer:HFRequency?': '1.00E+08',
	':FUNCtion1:FILTer:LFRequency?': '5.00E+07',
	':FUNCtion1:INTegrate:GATE?': 'ON',
	':FUNCtion1:INTegrate:OFFSet?': '1.00E-01',
	':FUNCtion:GVALue?': '-1.00E-07,1.00E-07',
	':FUNCtion:FFTDisplay?': 'SPLit',
	':FUNCtion1:FFT:UNIT?': 'DBVrms',
	':FUNCtion1:FFT:LOAD?': '50',
	':FUNCtion1:FFT:WINDow?': 'HANNing',
	':FUNCtion1:FFT:MODE?': 'AVERage,16',
	':FUNCtion1:FFT:POINts?': '2M',
	':FUNCtion1:FFT:SPAN?': '2.00E+06',
	':FUNCtion1:FFT:HCENter?': '2.00E+06Hz',
	':FUNCtion1:FFT:HSCale?': '1.00E+08',
	':FUNCtion1:FFT:SCALe?': '2.00E+01',
	':FUNCtion1:FFT:RLEVel?': '1.00E+01',
	':FUNCtion1:FFT:SEARch?': 'PEAK',
	':FUNCtion1:FFT:SEARch:EXCursion?': '2.00E+01',
	':FUNCtion1:FFT:SEARch:THReshold?': '-1.00E+02',
	':FUNCtion1:FFT:SEARch:RESult?': 'Peaks,1,9.536743E+02,2.231755E+00;2,3.099442E+03,-8.056905E+00;',
	':FUNCtion2:OPERation?': 'FFT',
	':FUNCtion2:FFT:MODE?': 'NORMal',
};

const commons = [':FUNCtion1?', ':FUNCtion1:OPERation?', ':FUNCtion1:SOURce1?', ':FUNCtion1:SOURce2?'];

const trailer = [
	':FUNCtion1:INVert?',
	':FUNCtion1:SCALe?',
	':FUNCtion1:POSition?',
	':FUNCtion1:LABel:TEXT?',
	':FUNCtion1:LABel?',
];

describe('EN11F math function tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the integrate operation with its gates', async () => {
		const state = payload(await call(harness, 'get_math'));
		expect(state).toBeEqual({
			function: 1,
			enabled: true,
			operation: 'INTegrate',
			source1: 'C1',
			source2: 'C2',
			integrate_gate: true,
			integrate_offset: { value: 0.1, raw: '1.00E-01' },
			gate_a: { value: -1e-7, raw: '-1.00E-07' },
			gate_b: { value: 1e-7, raw: '1.00E-07' },
			inverted: false,
			scale: { value: 1, raw: '1.00E+00' },
			position: { value: 0.5, raw: '5.00E-01' },
			label_text: 'MATH',
			label: true,
		});
		assertSent(harness.fake, [
			...commons,
			':FUNCtion1:INTegrate:GATE?',
			':FUNCtion1:INTegrate:OFFSet?',
			':FUNCtion:GVALue?',
			...trailer,
		]);
		await assertReadOnly(harness.client, 'get_math');
	});

	it('reads the settings of the operation in force and no other', async () => {
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'AVERage');
		const state = payload(await call(harness, 'get_math', { function: 1 }));
		expect(state.average_count).toBe(64);
		assertSent(harness.fake, [...commons, ':FUNCtion1:AVERage:NUM?', ...trailer]);
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'INTegrate');
	});

	it('asks a low-pass filter only for its lower frequency', async () => {
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'FILTer');
		harness.fake.replies.set(':FUNCtion1:FILTer:TYPe?', 'LPASs');
		const low = payload(await call(harness, 'get_math'));
		expect(low.filter_upper).toBe(undefined);
		assertSent(harness.fake, [...commons, ':FUNCtion1:FILTer:TYPe?', ':FUNCtion1:FILTer:LFRequency?', ...trailer]);
		harness.fake.replies.set(':FUNCtion1:FILTer:TYPe?', 'BPASs');
		const band = payload(await call(harness, 'get_math'));
		expect(band.filter_upper).toBeEqual({ value: 1e8, raw: '1.00E+08' });
		expect(band.filter_lower).toBeEqual({ value: 5e7, raw: '5.00E+07' });
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'INTegrate');
		harness.fake.sent();
	});

	it('warns about an unknown operation and reads no operation settings', async () => {
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'MYSTery');
		const state = payload(await call(harness, 'get_math'));
		expect(state.operation).toBeEqual({ raw: 'MYSTery' });
		expect(warnings(state).some((warning) => warning.includes('unknown math operation'))).toBeTruthy();
		assertSent(harness.fake, [...commons, ...trailer]);
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'INTegrate');
	});

	it('writes an arithmetic definition in table order and reads back what it set', async () => {
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'SUBTract');
		const result = payload(
			await call(harness, 'configure_math', {
				enabled: true,
				operation: 'SUBTract',
				source1: 'C1',
				source2: 'C2',
				inverted: false,
				label_text: 'MATH',
				label: true,
			}),
		);
		expect(result.commands).toBeEqual([
			':FUNCtion1 ON',
			':FUNCtion1:OPERation SUBTract',
			':FUNCtion1:SOURce1 C1',
			':FUNCtion1:SOURce2 C2',
			':FUNCtion1:INVert OFF',
			':FUNCtion1:LABel:TEXT "MATH"',
			':FUNCtion1:LABel ON',
		]);
		expect(result.warnings).toBe(undefined);
		expect(result.state).toBeEqual({
			enabled: true,
			operation: 'SUBTract',
			source1: 'C1',
			source2: 'C2',
			inverted: false,
			label_text: 'MATH',
			label: true,
		});
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'INTegrate');
		harness.fake.sent();
	});

	it('writes the integrate gates as one positional pair and compares the read-back', async () => {
		const result = payload(
			await call(harness, 'configure_math', {
				operation: 'INTegrate',
				integrate_gate: true,
				gate_a: -1e-7,
				gate_b: 1e-7,
			}),
		);
		expect(result.commands).toBeEqual([
			':FUNCtion1:OPERation INTegrate',
			':FUNCtion1:INTegrate:GATE ON',
			':FUNCtion:GVALue -1.00E-07,1.00E-07',
		]);
		expect(result.state).toBeEqual({
			operation: 'INTegrate',
			integrate_gate: true,
			gate_a: { value: -1e-7, raw: '-1.00E-07' },
			gate_b: { value: 1e-7, raw: '1.00E-07' },
		});
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':FUNCtion1:OPERation INTegrate',
			':FUNCtion1:INTegrate:GATE ON',
			':FUNCtion:GVALue -1.00E-07,1.00E-07',
			':FUNCtion1:OPERation?',
			':FUNCtion1:INTegrate:GATE?',
			':FUNCtion:GVALue?',
		]);
	});

	it('warns when the scope moves a gate to what it can take', async () => {
		harness.fake.replies.set(':FUNCtion:GVALue?', '-5.00E-08,1.00E-07');
		const result = payload(
			await call(harness, 'configure_math', { operation: 'INTegrate', gate_a: -1e-7, gate_b: 1e-7 }),
		);
		expect(warnings(result).some((warning) => warning.includes('gate_a'))).toBeTruthy();
		harness.fake.replies.set(':FUNCtion:GVALue?', '-1.00E-07,1.00E-07');
		harness.fake.sent();
	});

	it('refuses a channel the model does not have before anything is sent', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			const result = await call(two, 'configure_math', { operation: 'ADD', source1: 'C4', source2: 'C1' });
			expect(result.isError).toBe(true);
			expect(payload(result).kind).toBe('unsupported');
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});

	it('sends nothing for a math setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_math', {});
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'SQUARE' });
		await assertInvalidSendsNothing(harness, 'configure_math', { average_count: 64 });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'DIFF', average_count: 64 });
		await assertInvalidSendsNothing(harness, 'configure_math', {
			operation: 'FILTer',
			filter_type: 'LPASs',
			filter_upper: 1e8,
		});
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'INTegrate', gate_a: -1e-7 });
		await assertInvalidSendsNothing(harness, 'configure_math', {
			operation: 'INTegrate',
			gate_a: 2e-7,
			gate_b: 1e-7,
		});
		await assertInvalidSendsNothing(harness, 'configure_math', { function: 2, operation: 'SQRT', source1: 'F2' });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'ADD', unknown: true });
		await assertInvalidSendsNothing(harness, 'configure_math', { function: 5, operation: 'ADD' });
	});
});

describe('EN11F FFT tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole FFT of one function', async () => {
		const state = payload(await call(harness, 'get_fft'));
		expect(state).toBeEqual({
			function: 1,
			enabled: true,
			operation: 'INTegrate',
			source: 'C1',
			display: 'SPLit',
			unit: 'DBVrms',
			load: 50,
			window: 'HANNing',
			mode: 'AVERage',
			average_count: 16,
			points: '2M',
			span: { value: 2e6, raw: '2.00E+06' },
			center_frequency: { value: 2e6, unit: 'Hz', raw: '2.00E+06Hz' },
			horizontal_scale: { value: 1e8, raw: '1.00E+08' },
			vertical_scale: { value: 20, raw: '2.00E+01' },
			reference_level: { value: 10, raw: '1.00E+01' },
			search: 'PEAK',
			search_excursion: { value: 20, raw: '2.00E+01' },
			search_threshold: { value: -100, raw: '-1.00E+02' },
			warnings: state.warnings,
		});
		expect(warnings(state).some((warning) => warning.includes('runs INTegrate'))).toBeTruthy();
		await assertReadOnly(harness.client, 'get_fft');
		harness.fake.sent();
	});

	it('switches a function to FFT when a source is given, with the unit ahead of its values', async () => {
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'FFT');
		const result = payload(
			await call(harness, 'configure_fft', {
				enabled: true,
				source: 'C1',
				display: 'SPLit',
				unit: 'DBVrms',
				mode: 'AVERage',
				average_count: 16,
				vertical_scale: 20,
			}),
		);
		expect(result.commands).toBeEqual([
			':FUNCtion1 ON',
			':FUNCtion1:OPERation FFT',
			':FUNCtion1:SOURce1 C1',
			':FUNCtion:FFTDisplay SPLit',
			':FUNCtion1:FFT:UNIT DBVrms',
			':FUNCtion1:FFT:MODE AVERage,16',
			':FUNCtion1:FFT:SCALe 2.00E+01',
		]);
		expect(result.state).toBeEqual({
			operation: 'FFT',
			source: 'C1',
			display: 'SPLit',
			enabled: true,
			unit: 'DBVrms',
			vertical_scale: { value: 20, raw: '2.00E+01' },
			mode: 'AVERage',
			average_count: 16,
		});
		expect(result.warnings).toBe(undefined);
		harness.fake.replies.set(':FUNCtion1:OPERation?', 'INTegrate');
		harness.fake.sent();
	});

	it('checks the operation before storing FFT settings without a source', async () => {
		const result = payload(await call(harness, 'configure_fft', { window: 'FLATtop' }));
		expect(result.commands).toBeEqual([':FUNCtion1:FFT:WINDow FLATtop']);
		expect(warnings(result).some((warning) => warning.includes('runs INTegrate'))).toBeTruthy();
		expect(warnings(result).some((warning) => warning.includes('FLATtop'))).toBeTruthy();
		assertSent(harness.fake, [':FUNCtion1:OPERation?', ':FUNCtion1:FFT:WINDow FLATtop', ':FUNCtion1:FFT:WINDow?']);
	});

	it('sends nothing for an FFT setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_fft', {});
		await assertInvalidSendsNothing(harness, 'configure_fft', { average_count: 16 });
		await assertInvalidSendsNothing(harness, 'configure_fft', { mode: 'NORMal', average_count: 16 });
		await assertInvalidSendsNothing(harness, 'configure_fft', { points: '3M' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { function: 1, source: 'F1' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { window: 'FLATtop', unknown: true });
	});

	it('autosets the FFT and returns where the trace landed', async () => {
		const result = payload(await call(harness, 'autoset_fft', { mode: 'NORMal' }));
		expect(result.commands).toBeEqual([':FUNCtion1:FFT:AUToset NORMal']);
		expect(result.state).toBeEqual({
			span: { value: 2e6, raw: '2.00E+06' },
			center_frequency: { value: 2e6, unit: 'Hz', raw: '2.00E+06Hz' },
			vertical_scale: { value: 20, raw: '2.00E+01' },
			reference_level: { value: 10, raw: '1.00E+01' },
		});
		assertSent(harness.fake, [
			':FUNCtion1:FFT:AUToset NORMal',
			':FUNCtion1:FFT:SPAN?',
			':FUNCtion1:FFT:HCENter?',
			':FUNCtion1:FFT:SCALe?',
			':FUNCtion1:FFT:RLEVel?',
		]);
		await assertInvalidSendsNothing(harness, 'autoset_fft', {});
		await assertInvalidSendsNothing(harness, 'autoset_fft', { mode: 'FULL' });
	});

	it('restarts the average count and says when there is none', async () => {
		const { tools } = await harness.client.listTools();
		expect(tools.find((tool) => tool.name === 'reset_fft')?.annotations?.destructiveHint).toBe(true);
		const averaged = payload(await call(harness, 'reset_fft'));
		expect(averaged).toBeEqual({ mode: 'AVERage', average_count: 16, commands: [':FUNCtion1:FFT:RESET'] });
		assertSent(harness.fake, [':FUNCtion1:FFT:MODE?', ':FUNCtion1:FFT:RESET']);
		const normal = payload(await call(harness, 'reset_fft', { function: 2 }));
		expect(normal.commands).toBeEqual([':FUNCtion2:FFT:RESET']);
		expect(warnings(normal).some((warning) => warning.includes('no average count to restart'))).toBeTruthy();
		harness.fake.sent();
	});

	it('reads the peak table with its unit', async () => {
		const result = payload(await call(harness, 'read_fft_peaks'));
		expect(result).toBeEqual({
			search: 'PEAK',
			unit: 'DBVrms',
			type: 'Peaks',
			entries: [
				{ number: 1, frequency: 953.6743, amplitude: 2.231755 },
				{ number: 2, frequency: 3099.442, amplitude: -8.056905 },
			],
		});
		assertSent(harness.fake, [':FUNCtion1:FFT:SEARch?', ':FUNCtion1:FFT:UNIT?', ':FUNCtion1:FFT:SEARch:RESult?']);
		await assertReadOnly(harness.client, 'read_fft_peaks');
	});

	it('reads no table while the search is off', async () => {
		harness.fake.replies.set(':FUNCtion1:FFT:SEARch?', 'OFF');
		const result = payload(await call(harness, 'read_fft_peaks'));
		expect(result.search).toBe('OFF');
		expect(result.entries).toBe(undefined);
		expect(warnings(result).some((warning) => warning.includes('search of F1 is off'))).toBeTruthy();
		assertSent(harness.fake, [':FUNCtion1:FFT:SEARch?']);
		harness.fake.replies.set(':FUNCtion1:FFT:SEARch?', 'PEAK');
	});
});
