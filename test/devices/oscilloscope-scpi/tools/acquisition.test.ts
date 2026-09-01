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
	':ACQuire:MODE?': 'YT',
	':ACQuire:AMODe?': 'FAST',
	':ACQuire:INTerpolation?': 'ON',
	':ACQuire:SEQuence?': 'OFF',
	':ACQuire:SEQuence:COUNt?': '5',
	':ACQuire:MMANagement?': 'AUTO',
	':ACQuire:MDEPth?': '10M',
	':ACQuire:SRATe?': '1.00E+09',
	':ACQuire:TYPE?': 'AVERage,16',
	':ACQuire:NUMAcq?': '350',
	':ACQuire:POINts?': '1.25E+08',
};

async function connect(model = 'SDS804X HD', extra: Record<string, Reply> = {}): Promise<ScpiHarness> {
	const harness = await startScpiHarness(model, { ...replies, ...extra });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('EN11F acquisition tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('reads every documented setting and never asks a model the resolution is undocumented for', async () => {
		const state = payload(await call(harness, 'get_acquisition'));
		expect(state).toBeEqual({
			mode: 'YT',
			capture_rate: 'FAST',
			interpolation: 'sine',
			sequence: false,
			sequence_count: 5,
			memory_management: 'AUTO',
			memory_depth: '10M',
			sample_rate: { value: 1e9, raw: '1.00E+09' },
			acquisition_type: 'AVERage',
			average_count: 16,
			acquisition_type_raw: 'AVERage,16',
			acquisitions: 350,
			points: { value: 1.25e8, raw: '1.25E+08' },
		});
		assertSent(harness.fake, [
			':ACQuire:MODE?',
			':ACQuire:AMODe?',
			':ACQuire:INTerpolation?',
			':ACQuire:SEQuence?',
			':ACQuire:SEQuence:COUNt?',
			':ACQuire:MMANagement?',
			':ACQuire:MDEPth?',
			':ACQuire:SRATe?',
			':ACQuire:TYPE?',
			':ACQuire:NUMAcq?',
			':ACQuire:POINts?',
		]);
		await assertReadOnly(harness.client, 'get_acquisition');
	});

	it('settles mode, sequence and type before the memory depth they limit', async () => {
		harness.fake.replies.set(':ACQuire:MODE?', 'ROLL');
		harness.fake.replies.set(':ACQuire:INTerpolation?', 'OFF');
		harness.fake.replies.set(':ACQuire:MMANagement?', 'FMDepth');
		harness.fake.replies.set(':ACQuire:TYPE?', 'PEAK');
		const result = payload(
			await call(harness, 'configure_acquisition', {
				mode: 'ROLL',
				interpolation: 'linear',
				sequence: false,
				acquisition_type: 'PEAK',
				memory_management: 'FMDepth',
				memory_depth: '10M',
				sample_rate: 1e9,
			}),
		);
		expect(result.commands).toBeEqual([
			':ACQuire:MODE ROLL',
			':ACQuire:INTerpolation OFF',
			':ACQuire:SEQuence OFF',
			':ACQuire:TYPE PEAK',
			':ACQuire:MMANagement FMDepth',
			':ACQuire:MDEPth 10M',
			':ACQuire:SRATe 1.00E+09',
		]);
		expect(result.state).toBeEqual({
			mode: 'ROLL',
			interpolation: 'linear',
			sequence: false,
			memory_management: 'FMDepth',
			memory_depth: '10M',
			sample_rate: { value: 1e9, raw: '1.00E+09' },
			acquisition_type: 'PEAK',
			acquisition_type_raw: 'PEAK',
		});
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':ACQuire:MODE ROLL',
			':ACQuire:INTerpolation OFF',
			':ACQuire:SEQuence OFF',
			':ACQuire:TYPE PEAK',
			':ACQuire:MMANagement FMDepth',
			':ACQuire:MDEPth 10M',
			':ACQuire:SRATe 1.00E+09',
			':ACQuire:MODE?',
			':ACQuire:INTerpolation?',
			':ACQuire:SEQuence?',
			':ACQuire:MMANagement?',
			':ACQuire:MDEPth?',
			':ACQuire:SRATe?',
			':ACQuire:TYPE?',
		]);
	});

	it('carries the average count and the enhanced bits in the type command', async () => {
		harness.fake.replies.set(':ACQuire:TYPE?', 'AVERage,16');
		const averaged = payload(
			await call(harness, 'configure_acquisition', { acquisition_type: 'AVERage', average_count: 16 }),
		);
		expect(averaged.commands).toBeEqual([':ACQuire:TYPE AVERage,16']);
		expect(averaged.state).toBeEqual({
			acquisition_type: 'AVERage',
			average_count: 16,
			acquisition_type_raw: 'AVERage,16',
		});
		harness.fake.replies.set(':ACQuire:TYPE?', 'ERES,1.0');
		const enhanced = payload(
			await call(harness, 'configure_acquisition', { acquisition_type: 'ERES', enhanced_bits: 1 }),
		);
		expect(enhanced.commands).toBeEqual([':ACQuire:TYPE ERES,1.0']);
		expect(enhanced.state).toBeEqual({ acquisition_type: 'ERES', enhanced_bits: 1, acquisition_type_raw: 'ERES,1.0' });
		harness.fake.sent();
	});

	it('warns about a memory depth the scope did not take', async () => {
		harness.fake.replies.set(':ACQuire:MDEPth?', '10M');
		const result = payload(await call(harness, 'configure_acquisition', { memory_depth: '200M' }));
		expect((result.warnings as string[]).some((warning) => warning.includes('memory_depth'))).toBeTruthy();
		harness.fake.sent();
	});

	it('refuses the ADC resolution on a model the guide does not document it for', async () => {
		const result = await assertInvalidSendsNothing(harness, 'configure_acquisition', { resolution: '10Bits' });
		assertCapabilityError(result, 'SDS804X HD');
	});

	it('declares the discarding operations destructive', async () => {
		const { tools } = await harness.client.listTools();
		for (const name of ['clear_sweeps']) {
			const annotations = tools.find((tool) => tool.name === name)?.annotations;
			expect(annotations?.destructiveHint).toBe(true);
		}
	});

	it('keeps an acquisition count the scope cannot number as raw text, with a warning', async () => {
		harness.fake.replies.set(':ACQuire:NUMAcq?', 'N/A');
		try {
			const state = payload(await call(harness, 'get_acquisition'));
			expect(state.acquisitions).toBeEqual({ raw: 'N/A' });
			expect((state.warnings as string[]).some((warning) => warning.includes('acquisitions'))).toBeTruthy();
		} finally {
			harness.fake.replies.set(':ACQuire:NUMAcq?', '350');
			harness.fake.sent();
		}
	});

	it('clears the sweeps without reading anything back', async () => {
		const result = payload(await call(harness, 'clear_sweeps'));
		expect(result.commands).toBeEqual([':ACQuire:CSWeep']);
		assertSent(harness.fake, [':ACQuire:CSWeep']);
	});

	it('sends nothing for an acquisition setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_acquisition', {});
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { mode: 'YT', capture_rte: 'FAST' });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { memory_depth: '3k' });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { mode: 'ROLLing' });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { sample_rate: 0 });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { sequence_count: 0 });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', {
			acquisition_type: 'NORMal',
			average_count: 16,
		});
		await assertInvalidSendsNothing(harness, 'configure_acquisition', {
			acquisition_type: 'AVERage',
			enhanced_bits: 1,
		});
		await assertInvalidSendsNothing(harness, 'configure_acquisition', {
			acquisition_type: 'AVERage',
			average_count: 3,
		});
		await assertInvalidSendsNothing(harness, 'configure_acquisition', {
			acquisition_type: 'AVERage',
			average_count: 16,
			sequence: true,
		});
	});
});

describe('EN11F ADC resolution on the SDS2000X Plus', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await connect('SDS2104X Plus', { ':ACQuire:RESolution?': '8Bits' });
	});

	after(() => harness.close());

	it('probes the resolution at the handshake and reports it with the acquisition state', async () => {
		expect(harness.scope.capabilities?.resolution).toBeEqual({ bits: 8 });
		const state = payload(await call(harness, 'get_acquisition'));
		expect(state.resolution).toBeEqual({ bits: 8, raw: '8Bits' });
		expect(harness.fake.sent()[0]).toBe(':ACQuire:RESolution?');
	});

	it('updates the cached ADC state a later waveform scaling reads when the resolution changes', async () => {
		harness.fake.replies.set(':ACQuire:RESolution?', '10Bits');
		const result = payload(await call(harness, 'configure_acquisition', { resolution: '10Bits' }));
		expect(result.commands).toBeEqual([':ACQuire:RESolution 10Bits']);
		expect((result.state as Record<string, unknown>).resolution).toBeEqual({ bits: 10, raw: '10Bits' });
		expect(harness.scope.capabilities?.resolution).toBeEqual({ bits: 10 });
		assertSent(harness.fake, [':ACQuire:RESolution 10Bits', ':ACQuire:RESolution?']);
	});

	it('warns when the scope kept the resolution it had', async () => {
		harness.fake.replies.set(':ACQuire:RESolution?', '10Bits');
		const result = payload(await call(harness, 'configure_acquisition', { resolution: '8Bits' }));
		expect((result.warnings as string[]).some((warning) => warning.includes('resolution'))).toBeTruthy();
		harness.fake.sent();
	});
});
