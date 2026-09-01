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
	':MEASure?': 'ON',
	':MEASure:MODE?': 'ADVanced',
	':MEASure:SIMPle:SOURce?': 'C1',
	':MEASure:SIMPle:VALue? ALL': '2.000E+00,1.000E+00',
	':MEASure:SIMPle:VALue? MAX': '2.000E+00',
	':MEASure:SIMPle:VALue? PKPK': '****',
	':MEASure:ADVanced:LINenumber?': '2',
	':MEASure:ADVanced:STYLe?': 'M1',
	':MEASure:ADVanced:P1?': 'ON',
	':MEASure:ADVanced:P1:TYPE?': 'SKEW',
	':MEASure:ADVanced:P1:SOURce1?': 'C1',
	':MEASure:ADVanced:P1:SOURce2?': 'C2',
	':MEASure:ADVanced:P1:VALue?': '4.033E+00',
	':MEASure:ADVanced:P1:STATistics? ALL': '6.7E-02,6.8E-02,7.0E-02,6.5E-02,1.0E-03,128',
	':MEASure:ADVanced:P1:STATistics? CURRent': '6.7E-02',
	':MEASure:ADVanced:P2?': 'OFF',
	':MEASure:ADVanced:STATistics?': 'ON',
	':MEASure:ADVanced:STATistics:HISTOGram?': 'ON',
	':MEASure:ADVanced:STATistics:MAXCount?': '1024',
	':MEASure:ADVanced:STATistics:AIMLimit?': '500',
	':MEASure:ASTRategy?': 'AUTO',
	':MEASure:ASTRategy:TOP?': 'HISTogram',
	':MEASure:ASTRategy:BASE?': 'HISTogram',
	':MEASure:GATE?': 'ON',
	':MEASure:GATE:GA?': '-1.00E-07',
	':MEASure:GATE:GB?': '1.00E-07',
	':MEASure:THReshold:SOURce?': 'C1',
	':MEASure:THReshold:TYPE?': 'PERCent',
	':MEASure:THReshold:ABSolute?': '3.00E+00,1.00E+00,-1.50E+00',
	':MEASure:THReshold:PERCent?': '80,45,10',
};

describe('EN11F measure tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole subsystem, both threshold triples included', async () => {
		const state = payload(await call(harness, 'get_measurement_setup'));
		expect(state).toBeEqual({
			measurement: true,
			mode: 'ADVanced',
			simple_source: 'C1',
			advanced_items: 2,
			advanced_style: 'M1',
			amplitude_strategy: 'AUTO',
			amplitude_top: 'HISTogram',
			amplitude_base: 'HISTogram',
			threshold_source: 'C1',
			threshold_type: 'PERCent',
			threshold_absolute: {
				high: { value: 3, raw: '3.00E+00' },
				mid: { value: 1, raw: '1.00E+00' },
				low: { value: -1.5, raw: '-1.50E+00' },
			},
			threshold_percent: { high: 80, mid: 45, low: 10 },
		});
		assertSent(harness.fake, [
			':MEASure?',
			':MEASure:MODE?',
			':MEASure:SIMPle:SOURce?',
			':MEASure:ADVanced:LINenumber?',
			':MEASure:ADVanced:STYLe?',
			':MEASure:ASTRategy?',
			':MEASure:ASTRategy:TOP?',
			':MEASure:ASTRategy:BASE?',
			':MEASure:THReshold:SOURce?',
			':MEASure:THReshold:TYPE?',
			':MEASure:THReshold:ABSolute?',
			':MEASure:THReshold:PERCent?',
		]);
		await assertReadOnly(harness.client, 'get_measurement_setup');
	});

	it('sends the strategy before its rules and the threshold type before its triple', async () => {
		const result = payload(
			await call(harness, 'configure_measurement_setup', {
				measurement: true,
				mode: 'ADVanced',
				amplitude_strategy: 'AUTO',
				amplitude_top: 'HISTogram',
				amplitude_base: 'HISTogram',
				threshold_type: 'PERCent',
				threshold_absolute: { high: 3, mid: 1, low: -1.5 },
				threshold_percent: { high: 80, mid: 45, low: 10 },
			}),
		);
		expect(result.commands).toBeEqual([
			':MEASure ON',
			':MEASure:MODE ADVanced',
			':MEASure:ASTRategy AUTO',
			':MEASure:ASTRategy:TOP HISTogram',
			':MEASure:ASTRategy:BASE HISTogram',
			':MEASure:THReshold:TYPE PERCent',
			':MEASure:THReshold:ABSolute 3.00E+00,1.00E+00,-1.50E+00',
			':MEASure:THReshold:PERCent 80,45,10',
		]);
		expect(result.warnings).toBe(undefined);
		harness.fake.sent();
	});

	it('reads and writes both gate positions, which this dialect queries', async () => {
		expect(payload(await call(harness, 'get_measurement_gate'))).toBeEqual({
			enabled: true,
			gate_a: { value: -1e-7, raw: '-1.00E-07' },
			gate_b: { value: 1e-7, raw: '1.00E-07' },
		});
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_measurement_gate', { gate_a: -1e-7, gate_b: 1e-7 }));
		expect(result.commands).toBeEqual([':MEASure:GATE:GA -1.00E-07', ':MEASure:GATE:GB 1.00E-07']);
		assertSent(harness.fake, [
			':MEASure:GATE:GA -1.00E-07',
			':MEASure:GATE:GB 1.00E-07',
			':MEASure:GATE:GA?',
			':MEASure:GATE:GB?',
		]);
	});

	it('names all statistics in their interpreted order and reports that uncertainty', async () => {
		const result = payload(await call(harness, 'get_measurement_statistics'));
		const [first, second] = result.items as Array<Record<string, unknown>>;
		expect(second).toBeEqual({ item: 2, enabled: false });
		expect(first?.statistics).toBeEqual({
			current: { value: 0.067, raw: '6.7E-02' },
			mean: { value: 0.068, raw: '6.8E-02' },
			max: { value: 0.07, raw: '7.0E-02' },
			min: { value: 0.065, raw: '6.5E-02' },
			stdev: { value: 0.001, raw: '1.0E-03' },
			count: { value: 128, raw: '128' },
			raw: '6.7E-02,6.8E-02,7.0E-02,6.5E-02,1.0E-03,128',
		});
		expect((result.warnings as string[]).some((warning) => warning.includes('not verified on hardware'))).toBeTruthy();
		assertSent(harness.fake, [
			':MEASure:ADVanced:STATistics?',
			':MEASure:ADVanced:STATistics:HISTOGram?',
			':MEASure:ADVanced:STATistics:MAXCount?',
			':MEASure:ADVanced:STATistics:AIMLimit?',
			':MEASure:ADVanced:LINenumber?',
			':MEASure:ADVanced:P1?',
			':MEASure:ADVanced:P1:TYPE?',
			':MEASure:ADVanced:P1:SOURce1?',
			':MEASure:ADVanced:P1:SOURce2?',
			':MEASure:ADVanced:P1:VALue?',
			':MEASure:ADVanced:P1:STATistics? ALL',
			':MEASure:ADVanced:P2?',
		]);
	});

	it('asks no item for a statistic while the statistics are off', async () => {
		const off = await startScpiHarness('SDS804X HD', { ...replies, ':MEASure:ADVanced:STATistics?': 'OFF' });
		try {
			await call(off, 'identify');
			off.fake.sent();
			const result = payload(await call(off, 'get_measurement_statistics'));
			expect(result.statistics).toBe(false);
			expect(result.items).toBe(undefined);
			expect((result.warnings as string[]).some((warning) => warning.includes('statistics are off'))).toBeTruthy();
			expect(off.fake.sent().filter((line) => line.includes(':P'))).toBeEqual([]);
		} finally {
			await off.close();
		}
	});

	it('declares the statistics reset destructive, like clear_measurements', async () => {
		const { tools } = await harness.client.listTools();
		for (const name of ['configure_measurement_statistics', 'clear_measurements']) {
			const annotations = tools.find((tool) => tool.name === name)?.annotations;
			expect(annotations?.destructiveHint).toBe(true);
		}
	});

	it('sends the statistics reset last and does not read it back', async () => {
		const result = payload(await call(harness, 'configure_measurement_statistics', { max_count: 1024, reset: true }));
		expect(result.commands).toBeEqual([
			':MEASure:ADVanced:STATistics:MAXCount 1024',
			':MEASure:ADVanced:STATistics:RESet',
		]);
		expect(result.state).toBeEqual({ max_count: 1024 });
		harness.fake.sent();
	});

	it('installs simple items and keeps an unmeasurable value raw', async () => {
		const result = payload(await call(harness, 'measure', { source: 'C1', parameters: ['MAX', 'PKPK'] }));
		expect(result.commands).toBeEqual([
			':MEASure ON',
			':MEASure:MODE SIMPle',
			':MEASure:SIMPle:SOURce C1',
			':MEASure:SIMPle:ITEM MAX,ON',
			':MEASure:SIMPle:ITEM PKPK,ON',
		]);
		expect(result.values).toBeEqual([
			{ parameter: 'MAX', value: { value: 2, raw: '2.000E+00' } },
			{ parameter: 'PKPK', value: { raw: '****' } },
		]);
		expect((result.warnings as string[]).some((warning) => warning.includes('****'))).toBeTruthy();
		harness.fake.sent();
	});

	it('reads without installing anything and reports the source the scope holds', async () => {
		const result = payload(await call(harness, 'read_measurement'));
		expect(result.source).toBe('C1');
		expect(result.values).toBeEqual([
			{
				parameter: 'ALL',
				values: [
					{ value: 2, raw: '2.000E+00' },
					{ value: 1, raw: '1.000E+00' },
				],
				raw: '2.000E+00,1.000E+00',
			},
		]);
		assertSent(harness.fake, [':MEASure:SIMPle:SOURce?', ':MEASure:SIMPle:VALue? ALL']);
		await assertReadOnly(harness.client, 'read_measurement');
	});

	it('asks for a second source only where the type has one, and skips an item that is off', async () => {
		const result = payload(await call(harness, 'list_measurements'));
		expect(result.items).toBeEqual([
			{
				item: 1,
				enabled: true,
				type: 'SKEW',
				source1: 'C1',
				source2: 'C2',
				value: { value: 4.033, raw: '4.033E+00' },
			},
			{ item: 2, enabled: false },
		]);
		assertSent(harness.fake, [
			':MEASure:ADVanced:LINenumber?',
			':MEASure:ADVanced:P1?',
			':MEASure:ADVanced:P1:TYPE?',
			':MEASure:ADVanced:P1:SOURce1?',
			':MEASure:ADVanced:P1:SOURce2?',
			':MEASure:ADVanced:P1:VALue?',
			':MEASure:ADVanced:P2?',
		]);
		await assertReadOnly(harness.client, 'list_measurements');
	});

	it('turns a slot on before configuring it and off after', async () => {
		const on = payload(
			await call(harness, 'configure_advanced_measurement', {
				item: 1,
				enabled: true,
				type: 'SKEW',
				source1: 'C1',
				source2: 'C2',
			}),
		);
		expect(on.commands).toBeEqual([
			':MEASure ON',
			':MEASure:MODE ADVanced',
			':MEASure:ADVanced:P1 ON',
			':MEASure:ADVanced:P1:TYPE SKEW',
			':MEASure:ADVanced:P1:SOURce1 C1',
			':MEASure:ADVanced:P1:SOURce2 C2',
		]);
		expect(on.value).toBeEqual({ value: 4.033, raw: '4.033E+00' });
		harness.fake.sent();
		const off = payload(await call(harness, 'configure_advanced_measurement', { item: 1, enabled: false }));
		expect(off.commands).toBeEqual([':MEASure ON', ':MEASure:MODE ADVanced', ':MEASure:ADVanced:P1 OFF']);
		harness.fake.sent();
	});

	it('installs a delay measurement the way the legacy MEAD tool does', async () => {
		const result = payload(await call(harness, 'measure_delay', { source_a: 'C1', source_b: 'C2', type: 'PHA' }));
		expect(result.commands).toBeEqual([
			':MEASure ON',
			':MEASure:MODE ADVanced',
			':MEASure:ADVanced:P1 ON',
			':MEASure:ADVanced:P1:TYPE PHA',
			':MEASure:ADVanced:P1:SOURce1 C1',
			':MEASure:ADVanced:P1:SOURce2 C2',
		]);
		expect(result.sources).toBe('C1-C2');
		expect(result.value).toBeEqual({ value: 4.033, raw: '4.033E+00' });
		harness.fake.sent();
	});

	it('clears the set it was asked for and nothing else', async () => {
		expect(payload(await call(harness, 'clear_measurements')).commands).toBeEqual([
			':MEASure:SIMPle:CLEar',
			':MEASure:ADVanced:CLEar',
		]);
		expect(payload(await call(harness, 'clear_measurements', { items: 'advanced' })).commands).toBeEqual([
			':MEASure:ADVanced:CLEar',
		]);
		harness.fake.sent();
	});

	// The install writes are accepted on hardware, but :MEASure:SIMPle:VALue? for either spelling never answers,
	// so both spellings are refused before a byte reaches the wire, identically in both tools.
	it('refuses the two simple-only rise and fall spellings before anything is sent', async () => {
		for (const parameter of ['RISE20T80', 'FALL80T20']) {
			for (const [name, args] of [
				['measure', { source: 'C1', parameter }],
				['measure', { source: 'C1', parameters: ['MAX', parameter] }],
				['read_measurement', { parameter }],
				['read_measurement', { parameters: [parameter] }],
			] as const) {
				const result = await call(harness, name, args as Record<string, unknown>);
				const error = assertCapabilityError(result, 'SDS804X HD');
				expect(error.error).toMatchRegex(/RISE10T90 or FALL90T10/);
				assertSent(harness.fake, []);
			}
		}
	});

	it('sends nothing for a measurement request outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_measurement_setup', {});
		await assertInvalidSendsNothing(harness, 'configure_measurement_setup', { mode: 'BOTH' });
		await assertInvalidSendsNothing(harness, 'configure_measurement_setup', { advanced_items: 13 });
		await assertInvalidSendsNothing(harness, 'configure_measurement_setup', {
			threshold_percent: { high: 10, mid: 45, low: 80 },
		});
		await assertInvalidSendsNothing(harness, 'configure_measurement_setup', { threshold_source: 'D0' });
		await assertInvalidSendsNothing(harness, 'configure_measurement_gate', { gate_a: 1e-7, gate_b: -1e-7 });
		await assertInvalidSendsNothing(harness, 'configure_measurement_statistics', { max_count: 1025 });
		await assertInvalidSendsNothing(harness, 'measure', { source: 'C1' });
		await assertInvalidSendsNothing(harness, 'measure', { parameter: 'MAX' });
		await assertInvalidSendsNothing(harness, 'measure', { source: 'C1', parameter: 'SKEW' });
		await assertInvalidSendsNothing(harness, 'measure', { source: 'C1', parameter: 'RISE10T90' });
		await assertInvalidSendsNothing(harness, 'read_measurement', { parameter: 'PHA' });
		await assertInvalidSendsNothing(harness, 'list_measurements', { item: 0 });
		await assertInvalidSendsNothing(harness, 'configure_advanced_measurement', { item: 1, source2: 'C2', type: 'MAX' });
		await assertInvalidSendsNothing(harness, 'configure_advanced_measurement', {
			item: 1,
			type: 'SKEW',
			source1: 'F1',
			source2: 'C2',
		});
		await assertInvalidSendsNothing(harness, 'configure_advanced_measurement', { item: 13, type: 'MAX' });
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C1', source_b: 'F1', type: 'PHA' });
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C1', source_b: 'C2', type: 'MAX' });
		await assertInvalidSendsNothing(harness, 'clear_measurements', { items: 'everything' });
	});
});

describe('EN11F measure gates', () => {
	it('refuses a channel the model does not have and warns about a source it cannot verify', async () => {
		const harness = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(harness, 'identify');
			harness.fake.sent();
			assertCapabilityError(
				await call(harness, 'measure_delay', { source_a: 'C1', source_b: 'C3', type: 'PHA' }),
				'SDS802X HD',
			);
			assertSent(harness.fake, []);
			const result = payload(await call(harness, 'measure', { source: 'F1', parameter: 'MAX' }));
			expect((result.warnings as string[]).some((warning) => warning.includes('F1'))).toBeTruthy();
		} finally {
			await harness.close();
		}
	});
});
