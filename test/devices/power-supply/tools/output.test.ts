import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import type { ToolError } from '../../../../src/tools/define.ts';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type SupplyHarness, startSupplyHarness, text } from '../../../support/harness.ts';

const call = (harness: SupplyHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

async function connect(model: string, replies: Record<string, Reply> = {}): Promise<SupplyHarness> {
	const harness = await startSupplyHarness(model, replies);
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('output tools on SPD1168X', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD1168X', {
			'MEASure:VOLTage? CH1': '16.000',
			'MEASure:CURRent? CH1': '3.000',
			'MEASure:POWEr? CH1': '48.000',
			'CH1:VOLTage?': '15.000',
			'CH1:CURRent?': '0.500',
		});
	});

	after(() => harness.close());

	it('measures voltage, current and power', async () => {
		const measured = payload(await call(harness, 'measure_output'));
		expect(measured).toBeEqual({
			channel: 'CH1',
			voltage: { value: 16, raw: '16.000' },
			current: { value: 3, raw: '3.000' },
			power: { value: 48, raw: '48.000' },
		});
		assertSent(harness.fake, ['MEASure:VOLTage? CH1', 'MEASure:CURRent? CH1', 'MEASure:POWEr? CH1']);
		await assertReadOnly(harness.client, 'measure_output');
	});

	it('reads both setpoints without writing anything', async () => {
		const state = payload(await call(harness, 'get_output'));
		expect(state).toBeEqual({
			channel: 'CH1',
			voltage: { value: 15, raw: '15.000' },
			current: { value: 0.5, raw: '0.500' },
		});
		assertSent(harness.fake, ['CH1:VOLTage?', 'CH1:CURRent?']);
		await assertReadOnly(harness.client, 'get_output');
	});

	it('sets voltage, current and wire mode as plain decimals and reads back what it set', async () => {
		const result = payload(await call(harness, 'configure_output', { voltage: 15, current: 0.5, wire_mode: '4W' }));
		expect(result.commands).toBeEqual(['CH1:VOLTage 15.000', 'CH1:CURRent 0.500', 'MODE:SET 4W']);
		expect(result.state).toBeEqual({
			voltage: { value: 15, raw: '15.000' },
			current: { value: 0.5, raw: '0.500' },
		});
		expect(result.write_only).toBeEqual(['MODE:SET']);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			'CH1:VOLTage 15.000',
			'CH1:CURRent 0.500',
			'MODE:SET 4W',
			'CH1:VOLTage?',
			'CH1:CURRent?',
		]);
	});

	it('refuses a voltage above the documented 16 V rating before anything is sent', async () => {
		const result = await call(harness, 'configure_output', { voltage: 17 });
		expect(result.isError).toBe(true);
		const error = JSON.parse(text(result)) as ToolError;
		expect(error.error).toMatchRegex(/SPD1168X outputs up to 16 V/);
		assertSent(harness.fake, []);
	});

	it('refuses CH2 on a one-channel supply before anything is sent', async () => {
		assertCapabilityError(await call(harness, 'measure_output', { channel: 'CH2' }), 'SPD1168X');
		assertCapabilityError(await call(harness, 'get_output', { channel: 'CH2' }), 'SPD1168X');
		assertSent(harness.fake, []);
	});

	it('turns the output and the waveform display on', async () => {
		const result = payload(await call(harness, 'set_output', { enabled: true, wave: true }));
		expect(result.commands).toBeEqual(['OUTPut CH1,ON', 'OUTPut:WAVE CH1,ON']);
		expect(result.write_only).toBeEqual(['OUTPut', 'OUTPut:WAVE']);
		assertSent(harness.fake, ['OUTPut CH1,ON', 'OUTPut:WAVE CH1,ON']);
	});

	it('refuses the fixed CH3 and the track mode of the SPD3303 set', async () => {
		assertCapabilityError(await call(harness, 'set_output', { channel: 'CH3', enabled: true }), 'SPD1168X');
		assertCapabilityError(await call(harness, 'set_track_mode', { mode: 'parallel' }), 'SPD1168X');
		assertSent(harness.fake, []);
	});

	it('sends nothing on invalid input', async () => {
		await assertInvalidSendsNothing(harness, 'configure_output', { voltage: -1 });
		await assertInvalidSendsNothing(harness, 'configure_output', { wire_mode: '3W' });
		await assertInvalidSendsNothing(harness, 'configure_output', {});
		await assertInvalidSendsNothing(harness, 'set_output', {});
		await assertInvalidSendsNothing(harness, 'get_output', { channel: 'CH3' });
		await assertInvalidSendsNothing(harness, 'set_track_mode', { mode: 'both' });
	});
});

describe('output tools on SPD3303C', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD3303C', {
			'MEASure:VOLTage? CH2': '5.000',
			'MEASure:CURRent? CH2': '0.100',
			'CH2:VOLTage?': '5.000',
			'CH2:CURRent?': 'CC MODE',
		});
	});

	after(() => harness.close());

	it('measures CH2 without the undocumented MEASure:POWEr?', async () => {
		const measured = payload(await call(harness, 'measure_output', { channel: 'CH2' }));
		expect(measured).toBeEqual({
			channel: 'CH2',
			voltage: { value: 5, raw: '5.000' },
			current: { value: 0.1, raw: '0.100' },
		});
		assertSent(harness.fake, ['MEASure:VOLTage? CH2', 'MEASure:CURRent? CH2']);
	});

	it('programs CH2 and switches the fixed CH3', async () => {
		const configured = payload(await call(harness, 'configure_output', { channel: 'CH2', voltage: 5 }));
		expect(configured.commands).toBeEqual(['CH2:VOLTage 5.000']);
		const switched = payload(await call(harness, 'set_output', { channel: 'CH3', enabled: false }));
		expect(switched.commands).toBeEqual(['OUTPut CH3,OFF']);
		assertSent(harness.fake, ['CH2:VOLTage 5.000', 'CH2:VOLTage?', 'OUTPut CH3,OFF']);
	});

	it('keeps an unparseable setpoint as raw and warns instead of reporting a zero', async () => {
		const state = payload(await call(harness, 'get_output', { channel: 'CH2' }));
		expect(state.voltage).toBeEqual({ value: 5, raw: '5.000' });
		expect(state.current).toBeEqual({ raw: 'CC MODE' });
		expect(state.warnings).toBeEqual(['The current setpoint reads "CC MODE", which is not a number.']);
		assertSent(harness.fake, ['CH2:VOLTage?', 'CH2:CURRent?']);
	});

	it('maps the track modes onto OUTPut:TRACK 0|1|2', async () => {
		for (const [mode, wire] of [
			['independent', '0'],
			['series', '1'],
			['parallel', '2'],
		] as const) {
			const result = payload(await call(harness, 'set_track_mode', { mode }));
			expect(result.commands).toBeEqual([`OUTPut:TRACK ${wire}`]);
			expect(result.write_only).toBeEqual(['OUTPut:TRACK']);
		}
		assertSent(harness.fake, ['OUTPut:TRACK 0', 'OUTPut:TRACK 1', 'OUTPut:TRACK 2']);
	});

	it('refuses the SPD1000X-only waveform display before anything is sent', async () => {
		assertCapabilityError(await call(harness, 'set_output', { enabled: true, wave: true }), 'SPD3303C');
		assertSent(harness.fake, []);
	});

	it('refuses a voltage above the documented 32 V rating', async () => {
		const result = await call(harness, 'configure_output', { voltage: 33 });
		expect(result.isError).toBe(true);
		assertSent(harness.fake, []);
	});
});

describe('output tools on an unknown SPD model', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD4000', { 'CH1:VOLTage?': '3.000' });
	});

	after(() => harness.close());

	it('sends the request with a warning instead of a guessed rating', async () => {
		const result = payload(await call(harness, 'configure_output', { voltage: 3 }));
		expect(result.commands).toBeEqual(['CH1:VOLTage 3.000']);
		const warnings = result.warnings as string[];
		expect(warnings.some((warning) => warning.includes('command support is unknown'))).toBeTruthy();
		expect(warnings.some((warning) => warning.includes('output rating for SPD4000 is unknown'))).toBeTruthy();
	});
});
