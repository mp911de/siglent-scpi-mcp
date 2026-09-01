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
	'CONFigure?': 'DCV -0.04mV',
	'READ?': 'MM_VALUE 0.00V',
	'MEASure:CONTinuity?': 'Overload',
	'MEASure:RESistance? 600': '+6.71881065E+01',
	'MEASure:VOLTage:DC? 60V': '+2.43186951E-02',
	'MEASure:CURRent:AC? 6A': '+4.32133675E-04',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F handheld multimeter tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SHS1102X', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the present function and the value it measures', async () => {
		const state = payload(await call(harness, 'read_meter'));
		expect(state).toBeEqual({
			function: 'voltage_dc',
			code: 'DCV',
			displayed: '-0.04mV',
			raw: 'DCV -0.04mV',
			value: { value: 0, unit: 'V', raw: 'MM_VALUE 0.00V' },
		});
		assertSent(harness.fake, ['CONFigure?', 'READ?']);
		await assertReadOnly(harness.client, 'read_meter');
	});

	it('reports a reading out of range as the overload the guide documents', async () => {
		harness.fake.replies.set('READ?', 'Overload');
		const state = payload(await call(harness, 'read_meter'));
		expect(state.overload).toBeEqual(true);
		expect(state.value).toBe(undefined);
		expect(warnings(state)).toBeEqual([]);
		harness.fake.replies.set('READ?', replies['READ?'] as string);
		harness.fake.sent();
	});

	it('warns rather than guessing when the meter names a function the guide does not list', async () => {
		harness.fake.replies.set('CONFigure?', 'XYZ 1.0');
		const state = payload(await call(harness, 'read_meter'));
		expect(state.function).toBe(undefined);
		expect(state.code).toBe('XYZ');
		expect(warnings(state).some((warning) => warning.includes('documented function name'))).toBeTruthy();
		harness.fake.replies.set('CONFigure?', replies['CONFigure?'] as string);
		harness.fake.sent();
	});

	it('enters the meter, configures the function and only then its unit and relative reading', async () => {
		const result = payload(
			await call(harness, 'configure_meter', {
				meter: true,
				function: 'voltage_dc',
				range: '60V',
				unit: 'V',
				relative: true,
			}),
		);
		expect(result.commands).toBeEqual([
			'MMETer ON',
			'CONFigure:VOLTage:DC 60V',
			'VOLTage:DC:SELEct V',
			'VOLTage:DC:NULL ON',
		]);
		expect(result.write_only).toBeEqual(['MMETer', 'CONFigure:VOLTage:DC', 'VOLTage:DC:SELEct', 'VOLTage:DC:NULL']);
		expect(result.state).toBeEqual({ function: 'voltage_dc', code: 'DCV', raw: 'DCV -0.04mV' });
		assertSent(harness.fake, [
			'MMETer ON',
			'CONFigure:VOLTage:DC 60V',
			'VOLTage:DC:SELEct V',
			'VOLTage:DC:NULL ON',
			'CONFigure?',
		]);
	});

	it('leaves the meter without reading a function back', async () => {
		const result = payload(await call(harness, 'configure_meter', { meter: false }));
		expect(result.commands).toBeEqual(['MMETer OFF']);
		assertSent(harness.fake, ['MMETer OFF']);
	});

	it('warns when the meter reports another function than the one requested', async () => {
		const result = payload(await call(harness, 'configure_meter', { function: 'capacitance', relative: true }));
		expect(result.commands).toBeEqual(['CONFigure:CAPacitance', 'CAPacitance:NULL ON']);
		expect(warnings(result).some((warning) => warning.includes('capacitance'))).toBeTruthy();
		harness.fake.sent();
	});

	it('measures in one call and keeps the documented overload answer', async () => {
		const continuity = payload(await call(harness, 'measure_meter', { function: 'continuity' }));
		expect(continuity).toBeEqual({
			commands: ['MEASure:CONTinuity?'],
			function: 'continuity',
			overload: true,
			raw: 'Overload',
		});
		const resistance = payload(await call(harness, 'measure_meter', { function: 'resistance', range: '600' }));
		expect(resistance.value).toBeEqual({ value: 67.1881065, raw: '+6.71881065E+01' });
		assertSent(harness.fake, ['MEASure:CONTinuity?', 'MEASure:RESistance? 600']);
	});

	it('warns about a range the guide prints for the other handheld only', async () => {
		const eight = await startScpiHarness('SHS810X', replies);
		try {
			await call(eight, 'identify');
			const result = payload(await call(eight, 'configure_meter', { function: 'voltage_dc', range: '1000V' }));
			expect(result.commands).toBeEqual(['CONFigure:VOLTage:DC 1000V']);
			expect(warnings(result).some((warning) => warning.includes('SHS1000X'))).toBeTruthy();
			const allowed = payload(await call(harness, 'configure_meter', { function: 'voltage_dc', range: '60V' }));
			expect(warnings(allowed)).toBeEqual([]);
		} finally {
			await eight.close();
		}
		harness.fake.sent();
	});

	it('refuses every meter call on a model the guide documents no multimeter for', async () => {
		const bench = await startScpiHarness('SDS804X HD', replies);
		try {
			await call(bench, 'identify');
			bench.fake.sent();
			for (const [name, args] of [
				['read_meter', {}],
				['configure_meter', { meter: true }],
				['measure_meter', { function: 'diode' }],
			] as const) {
				assertCapabilityError(await call(bench, name, args), 'SDS804X HD');
			}
			assertSent(bench.fake, []);
		} finally {
			await bench.close();
		}
	});

	it('sends nothing for a request the guide does not document', async () => {
		await assertInvalidSendsNothing(harness, 'configure_meter', {});
		await assertInvalidSendsNothing(harness, 'configure_meter', { function: 'diode', range: '600' });
		await assertInvalidSendsNothing(harness, 'configure_meter', { function: 'diode', relative: true });
		await assertInvalidSendsNothing(harness, 'configure_meter', { function: 'resistance', unit: 'V' });
		await assertInvalidSendsNothing(harness, 'configure_meter', { function: 'voltage_dc', unit: 'MA' });
		await assertInvalidSendsNothing(harness, 'configure_meter', { range: '60V' });
		await assertInvalidSendsNothing(harness, 'configure_meter', { function: 'voltage_dc', range: '6A' });
		await assertInvalidSendsNothing(harness, 'measure_meter', { function: 'resistance', range: 'AUTO' });
		await assertInvalidSendsNothing(harness, 'measure_meter', { function: 'temperature' });
	});
});
