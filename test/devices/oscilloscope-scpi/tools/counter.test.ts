import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':COUNter?': 'ON',
	':COUNter:MODE?': 'FREQuency',
	':COUNter:SOURce?': 'C1',
	':COUNter:LEVel?': '5.00E-01',
	':COUNter:STATistics?': 'ON',
	':COUNter:TOTalizer:GATE?': 'ON',
	':COUNter:TOTalizer:GATE:LEVel?': '5.00E-01',
	':COUNter:TOTalizer:GATE:SLOPe?': 'RISing',
	':COUNter:TOTalizer:GATE:TYPE?': 'LEVel',
	':COUNter:TOTalizer:SLOPe?': 'RISing',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F counter tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the statistics of a counting mode and nothing of the totalizer', async () => {
		const state = payload(await call(harness, 'get_counter'));
		expect(state).toBeEqual({
			counter: true,
			mode: 'FREQuency',
			source: 'C1',
			level: { value: 0.5, raw: '5.00E-01' },
			statistics: true,
		});
		assertSent(harness.fake, [
			':COUNter?',
			':COUNter:MODE?',
			':COUNter:SOURce?',
			':COUNter:LEVel?',
			':COUNter:STATistics?',
		]);
		await assertReadOnly(harness.client, 'get_counter');
	});

	it('reads the gate of the totalizer mode and nothing of the statistics', async () => {
		harness.fake.replies.set(':COUNter:MODE?', 'TOTalizer');
		const state = payload(await call(harness, 'get_counter'));
		expect(state.gate_type).toBeEqual('LEVel');
		expect(state.statistics).toBe(undefined);
		assertSent(harness.fake, [
			':COUNter?',
			':COUNter:MODE?',
			':COUNter:SOURce?',
			':COUNter:LEVel?',
			':COUNter:TOTalizer:GATE?',
			':COUNter:TOTalizer:GATE:LEVel?',
			':COUNter:TOTalizer:GATE:SLOPe?',
			':COUNter:TOTalizer:GATE:TYPE?',
			':COUNter:TOTalizer:SLOPe?',
		]);
		harness.fake.replies.set(':COUNter:MODE?', 'FREQuency');
	});

	it('warns instead of guessing when the scope returns an unknown mode', async () => {
		harness.fake.replies.set(':COUNter:MODE?', 'PULSE');
		const result = payload(await call(harness, 'get_counter'));
		expect(result.mode).toBeEqual({ raw: 'PULSE' });
		expect(warnings(result).some((warning) => warning.includes('unknown counter mode'))).toBeTruthy();
		harness.fake.replies.set(':COUNter:MODE?', 'FREQuency');
		harness.fake.sent();
	});

	it('sends the mode before the settings it gives a meaning and the level as NR3', async () => {
		const result = payload(
			await call(harness, 'configure_counter', {
				counter: true,
				mode: 'TOTalizer',
				source: 'C1',
				level: 0.5,
				gate: true,
				gate_level: 0.5,
				gate_slope: 'RISing',
				gate_type: 'LEVel',
				totalizer_slope: 'RISing',
			}),
		);
		expect(result.commands).toBeEqual([
			':COUNter ON',
			':COUNter:MODE TOTalizer',
			':COUNter:SOURce C1',
			':COUNter:LEVel 5.00E-01',
			':COUNter:TOTalizer:GATE ON',
			':COUNter:TOTalizer:GATE:LEVel 5.00E-01',
			':COUNter:TOTalizer:GATE:SLOPe RISing',
			':COUNter:TOTalizer:GATE:TYPE LEVel',
			':COUNter:TOTalizer:SLOPe RISing',
		]);
		expect(warnings(result).some((warning) => warning.includes('mode was set to "TOTalizer"'))).toBeTruthy();
		harness.fake.sent();
	});

	it('resets the results the mode in force has', async () => {
		const statistics = payload(await call(harness, 'reset_counter'));
		expect(statistics.commands).toBeEqual([':COUNter:STATistics:RESet']);
		assertSent(harness.fake, [':COUNter:MODE?', ':COUNter:STATistics:RESet']);

		harness.fake.replies.set(':COUNter:MODE?', 'TOTalizer');
		const totalizer = payload(await call(harness, 'reset_counter'));
		expect(totalizer.commands).toBeEqual([':COUNter:TOTalizer:RESet']);
		assertSent(harness.fake, [':COUNter:MODE?', ':COUNter:TOTalizer:RESet']);
		harness.fake.replies.set(':COUNter:MODE?', 'FREQuency');
	});

	it('sends no reset for an unknown mode', async () => {
		harness.fake.replies.set(':COUNter:MODE?', 'PULSE');
		const result = payload(await call(harness, 'reset_counter'));
		expect(result.commands).toBeEqual([]);
		expect(warnings(result).some((warning) => warning.includes('unknown counter mode'))).toBeTruthy();
		assertSent(harness.fake, [':COUNter:MODE?']);
		harness.fake.replies.set(':COUNter:MODE?', 'FREQuency');
	});

	it('sends nothing for a counter setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_counter', {});
		await assertInvalidSendsNothing(harness, 'configure_counter', { mode: 'TOTalizer', statistics: true });
		await assertInvalidSendsNothing(harness, 'configure_counter', { mode: 'FREQuency', gate: true });
		await assertInvalidSendsNothing(harness, 'configure_counter', { mode: 'PERiod', totalizer_slope: 'RISing' });
		await assertInvalidSendsNothing(harness, 'configure_counter', { mode: 'PULSE' });
		await assertInvalidSendsNothing(harness, 'configure_counter', { source: 'F1' });
		await assertInvalidSendsNothing(harness, 'configure_counter', { level: '500MV' });
		await assertInvalidSendsNothing(harness, 'configure_counter', { gate_slope: 'EITHer' });
	});
});
