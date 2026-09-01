import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':DVM?': 'ON',
	':DVM:SOURce?': 'C2',
	':DVM:MODE?': 'AMPLitude',
	':DVM:ARANge?': 'ON',
	':DVM:ALARm?': 'ON',
	':DVM:HOLD?': 'OFF',
	':DVM:CURRent?': '0.98E+00',
};

const queries = [':DVM?', ':DVM:SOURce?', ':DVM:MODE?', ':DVM:ARANge?', ':DVM:ALARm?', ':DVM:HOLD?'];

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F DVM tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole voltmeter and its displayed value', async () => {
		const state = payload(await call(harness, 'get_dvm_reading'));
		expect(state).toBeEqual({
			dvm: true,
			source: 'C2',
			mode: 'AMPLitude',
			auto_range: true,
			alarm: true,
			hold: false,
			value: { value: 0.98, raw: '0.98E+00' },
		});
		assertSent(harness.fake, [...queries, ':DVM:CURRent?']);
		await assertReadOnly(harness.client, 'get_dvm_reading');
	});

	it('asks for no value while the voltmeter is off', async () => {
		harness.fake.replies.set(':DVM?', 'OFF');
		const result = payload(await call(harness, 'get_dvm_reading'));
		expect(result.value).toBe(undefined);
		expect(warnings(result).some((warning) => warning.includes('digital voltmeter is off'))).toBeTruthy();
		assertSent(harness.fake, queries);
		harness.fake.replies.set(':DVM?', 'ON');
	});

	it('says a held value is the frozen one, and keeps an answer that is not a number as raw text', async () => {
		harness.fake.replies.set(':DVM:HOLD?', 'ON');
		harness.fake.replies.set(':DVM:CURRent?', '****');
		const result = payload(await call(harness, 'get_dvm_reading'));
		expect(result.value).toBeEqual({ raw: '****' });
		expect(warnings(result).some((warning) => warning.includes('Hold is on'))).toBeTruthy();
		expect(warnings(result).some((warning) => warning.includes('The displayed value'))).toBeTruthy();
		harness.fake.replies.set(':DVM:HOLD?', 'OFF');
		harness.fake.replies.set(':DVM:CURRent?', '0.98E+00');
		harness.fake.sent();
	});

	it('switches the voltmeter on before the source and the mode, and holds last', async () => {
		const result = payload(
			await call(harness, 'configure_dvm', {
				dvm: true,
				source: 'C2',
				mode: 'AMPLitude',
				auto_range: true,
				alarm: true,
				hold: false,
			}),
		);
		expect(result.commands).toBeEqual([
			':DVM ON',
			':DVM:SOURce C2',
			':DVM:MODE AMPLitude',
			':DVM:ARANge ON',
			':DVM:ALARm ON',
			':DVM:HOLD OFF',
		]);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':DVM ON',
			':DVM:SOURce C2',
			':DVM:MODE AMPLitude',
			':DVM:ARANge ON',
			':DVM:ALARm ON',
			':DVM:HOLD OFF',
			...queries,
		]);
	});

	it('reads back only what it set', async () => {
		const result = payload(await call(harness, 'configure_dvm', { mode: 'AMPLitude' }));
		expect(result.state).toBeEqual({ mode: 'AMPLitude' });
		assertSent(harness.fake, [':DVM:MODE AMPLitude', ':DVM:MODE?']);
	});

	it('sends nothing for a voltmeter setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_dvm', {});
		await assertInvalidSendsNothing(harness, 'configure_dvm', { mode: 'ACAVg' });
		await assertInvalidSendsNothing(harness, 'configure_dvm', { source: 'F1' });
		await assertInvalidSendsNothing(harness, 'configure_dvm', { dvm: 'ON' });
	});

	it('refuses a channel the model does not have before anything is sent', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			const result = await call(two, 'configure_dvm', { source: 'C4' });
			expect(result.isError).toBe(true);
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
