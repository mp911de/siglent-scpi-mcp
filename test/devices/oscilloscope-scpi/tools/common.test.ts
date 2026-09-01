import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('EN11F common tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', { '*OPC?': '1' });
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('waits for completion with the query form the guide documents', async () => {
		const waited = payload(await call(harness, 'wait_until_complete'));
		expect(waited).toBeEqual({ completed: true, raw: '1' });
		assertSent(harness.fake, ['*OPC?']);
		await assertReadOnly(harness.client, 'wait_until_complete');
	});

	it('fails a completion wait the scope does not answer with 1', async () => {
		harness.fake.replies.set('*OPC?', '0');
		const refused = await call(harness, 'wait_until_complete');
		expect(refused.isError).toBe(true);
		harness.fake.replies.set('*OPC?', '1');
		harness.fake.sent();
	});

	it('resets, waits and re-identifies only with the acknowledgement', async () => {
		await assertInvalidSendsNothing(harness, 'reset_scope', {});
		await assertInvalidSendsNothing(harness, 'reset_scope', { confirm_reset: false });
		const reset = payload(await call(harness, 'reset_scope', { confirm_reset: true }));
		expect(reset.commands).toBeEqual(['*RST']);
		expect(reset.reset).toBeEqual({ completed: true, raw: '1' });
		assertSent(harness.fake, ['*RST', '*OPC?', '*IDN?']);
	});

	it('keeps the raw escape hatches apart and sends nothing for the wrong one', async () => {
		const queried = payload(await call(harness, 'scpi_query', { command: '*IDN?' }));
		expect(String(queried.response)).toMatchRegex(/SDS804X HD/);
		assertSent(harness.fake, ['*IDN?']);
		const sent = payload(await call(harness, 'scpi_command', { command: ':AUToset' }));
		expect(sent.commands).toBeEqual([':AUToset']);
		assertSent(harness.fake, [':AUToset']);
		await assertInvalidSendsNothing(harness, 'scpi_query', { command: ':AUToset' });
		await assertInvalidSendsNothing(harness, 'scpi_command', { command: '*IDN?' });
		await assertInvalidSendsNothing(harness, 'scpi_query', { command: 'C1:VDIV?\nC2:VDIV?' });
	});
});
