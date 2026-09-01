import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':MTESt?': 'ON',
	':MTESt:COUNt?': 'FAIL,38176,PASS,5617,TOTAL,43793',
	':MTESt:FUNCtion:BUZZer?': 'ON',
	':MTESt:FUNCtion:COF?': 'OFF',
	':MTESt:FUNCtion:FTH?': 'ON',
	':MTESt:FUNCtion:SOF?': 'OFF',
	':MTESt:IDISplay?': 'ON',
	':MTESt:OPERate?': 'ON',
	':MTESt:SOURce?': 'C1',
	':MTESt:TYPE?': 'ALL_IN',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F mask test tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole mask test setup and none of its counts', async () => {
		const state = payload(await call(harness, 'get_mask_test'));
		expect(state).toBeEqual({
			mask_test: true,
			source: 'C1',
			type: 'ALL_IN',
			display_results: true,
			buzzer_on_fail: true,
			capture_on_fail: false,
			failure_to_history: true,
			stop_on_fail: false,
			running: true,
		});
		assertSent(harness.fake, [
			':MTESt?',
			':MTESt:SOURce?',
			':MTESt:TYPE?',
			':MTESt:IDISplay?',
			':MTESt:FUNCtion:BUZZer?',
			':MTESt:FUNCtion:COF?',
			':MTESt:FUNCtion:FTH?',
			':MTESt:FUNCtion:SOF?',
			':MTESt:OPERate?',
		]);
		await assertReadOnly(harness.client, 'get_mask_test');
	});

	it('sets the test up before it starts it and reads back only what the request named', async () => {
		const result = payload(
			await call(harness, 'configure_mask_test', { mask_test: true, source: 'C1', stop_on_fail: false, running: true }),
		);
		expect(result.commands).toBeEqual([
			':MTESt ON',
			':MTESt:SOURce C1',
			':MTESt:FUNCtion:SOF OFF',
			':MTESt:OPERate ON',
		]);
		assertSent(harness.fake, [
			...(result.commands as string[]),
			':MTESt?',
			':MTESt:SOURce?',
			':MTESt:FUNCtion:SOF?',
			':MTESt:OPERate?',
		]);
		expect(warnings(result)).toBeEqual([]);
	});

	it('warns that a zoomed source needs zoom and refuses an unknown field', async () => {
		harness.fake.replies.set(':MTESt:SOURce?', 'Z1');
		const result = payload(await call(harness, 'configure_mask_test', { source: 'Z1' }));
		expect(warnings(result).some((warning) => warning.includes('zoomed source'))).toBeTruthy();
		assertSent(harness.fake, [':MTESt:SOURce Z1', ':MTESt:SOURce?']);
		harness.fake.replies.set(':MTESt:SOURce?', 'C1');
		await assertInvalidSendsNothing(harness, 'configure_mask_test', { sourc: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_mask_test', { type: 'ALL_OVER' });
		await assertInvalidSendsNothing(harness, 'configure_mask_test', {});
	});

	it('reports the failed, passed and tested frame counts', async () => {
		const result = payload(await call(harness, 'read_mask_test_result'));
		expect(result).toBeEqual({ mask_test: true, running: true, failed: 38176, passed: 5617, total: 43793 });
		assertSent(harness.fake, [':MTESt?', ':MTESt:OPERate?', ':MTESt:COUNt?']);
		await assertReadOnly(harness.client, 'read_mask_test_result');
	});

	it('asks for no count while the mask test is off', async () => {
		harness.fake.replies.set(':MTESt?', 'OFF');
		const result = payload(await call(harness, 'read_mask_test_result'));
		expect(result.mask_test).toBeEqual(false);
		expect(result.total).toBe(undefined);
		expect(warnings(result).some((warning) => warning.includes('mask test is off'))).toBeTruthy();
		assertSent(harness.fake, [':MTESt?']);
		harness.fake.replies.set(':MTESt?', 'ON');
	});

	it('says the counts are those of the last run while the test is stopped', async () => {
		harness.fake.replies.set(':MTESt:OPERate?', 'OFF');
		const result = payload(await call(harness, 'read_mask_test_result'));
		expect(result.running).toBe(false);
		expect(warnings(result).some((warning) => warning.includes('last run'))).toBeTruthy();
		harness.fake.replies.set(':MTESt:OPERate?', 'ON');
		harness.fake.sent();
	});

	it('keeps the raw answer when the counts do not come back as the guide prints them', async () => {
		harness.fake.replies.set(':MTESt:COUNt?', 'NONE');
		const result = payload(await call(harness, 'read_mask_test_result'));
		expect(result.result).toBeEqual({ raw: 'NONE' });
		expect(warnings(result).some((warning) => warning.includes('FAIL, PASS and TOTAL'))).toBeTruthy();
		harness.fake.replies.set(':MTESt:COUNt?', 'FAIL,38176,PASS,5617,TOTAL,43793');
		harness.fake.sent();
	});

	it('discards the accumulated counts as a destructive call', async () => {
		const result = payload(await call(harness, 'reset_mask_test'));
		expect(result.commands).toBeEqual([':MTESt:RESet']);
		expect(result.write_only).toBeEqual([':MTESt:RESet']);
		assertSent(harness.fake, [':MTESt:RESet']);
		const { tools } = await harness.client.listTools();
		expect(tools.find(({ name }) => name === 'reset_mask_test')?.annotations?.destructiveHint).toBe(true);
	});

	it('builds a mask from two margins in NR2 and only with the acknowledgement', async () => {
		const result = payload(
			await call(harness, 'create_mask', { x_margin: 0.8, y_margin: 0.08, confirm_replace_mask: true }),
		);
		expect(result.commands).toBeEqual([':MTESt:MASK:CREate 0.80,0.08']);
		expect(result.write_only).toBeEqual([':MTESt:MASK:CREate']);
		assertSent(harness.fake, [':MTESt:MASK:CREate 0.80,0.08']);
		await assertInvalidSendsNothing(harness, 'create_mask', { x_margin: 0.8, y_margin: 0.08 });
		await assertInvalidSendsNothing(harness, 'create_mask', {
			x_margin: 0.01,
			y_margin: 0.08,
			confirm_replace_mask: true,
		});
	});

	it('recalls a mask from a slot or a file and refuses anything else', async () => {
		const slot = payload(await call(harness, 'load_mask', { slot: 3, confirm_replace_mask: true }));
		expect(slot.commands).toBeEqual([':MTESt:MASK:LOAD INTernal,3']);
		const file = payload(
			await call(harness, 'load_mask', { file: 'local/SIGLENT/TEST.msk', confirm_replace_mask: true }),
		);
		expect(file.commands).toBeEqual([':MTESt:MASK:LOAD EXTernal,"local/SIGLENT/TEST.msk"']);
		assertSent(harness.fake, [':MTESt:MASK:LOAD INTernal,3', ':MTESt:MASK:LOAD EXTernal,"local/SIGLENT/TEST.msk"']);
		const { tools } = await harness.client.listTools();
		expect(tools.find(({ name }) => name === 'load_mask')?.annotations?.destructiveHint).toBe(true);
		await assertInvalidSendsNothing(harness, 'load_mask', { confirm_replace_mask: true });
		await assertInvalidSendsNothing(harness, 'load_mask', {
			slot: 3,
			file: 'local/SIGLENT/TEST.msk',
			confirm_replace_mask: true,
		});
		await assertInvalidSendsNothing(harness, 'load_mask', { slot: 5, confirm_replace_mask: true });
		await assertInvalidSendsNothing(harness, 'load_mask', {
			file: 'local/SIGLENT/TEST.msk";:MTESt:RESet',
			confirm_replace_mask: true,
		});
		await assertInvalidSendsNothing(harness, 'load_mask', {
			file: 'local/SIGLENT/TEST.bin',
			confirm_replace_mask: true,
		});
	});

	it('refuses a channel the model does not have', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			const result = await call(two, 'configure_mask_test', { source: 'Z4' });
			expect(result.isError).toBe(true);
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
