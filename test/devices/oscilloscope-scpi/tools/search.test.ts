import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':SEARch?': 'ON',
	':SEARch:MODE?': 'EDGE',
	':SEARch:COUNt?': '10',
	':SEARch:EVENt?': '5',
	':SEARch:EDGE:SOURce?': 'C2',
	':SEARch:EDGE:SLOPe?': 'ALTernate',
	':SEARch:EDGE:LEVel?': '5.00E-01',
	':SEARch:RUNT:SOURce?': 'C2',
	':SEARch:RUNT:POLarity?': 'NEGative',
	':SEARch:RUNT:HLEVel?': '5.00E-01',
	':SEARch:RUNT:LLEVel?': '-5.00E-01',
	':SEARch:RUNT:LIMit?': 'INNer',
	':SEARch:RUNT:TLOWer?': '1.00E-08',
	':SEARch:RUNT:TUPPer?': '3.00E-08',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F search tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the state, the mode and the parameters of that mode alone', async () => {
		const state = payload(await call(harness, 'get_search'));
		expect(state).toBeEqual({
			search: true,
			mode: 'EDGE',
			source: 'C2',
			slope: 'ALTernate',
			level: { value: 0.5, raw: '5.00E-01' },
		});
		assertSent(harness.fake, [
			':SEARch?',
			':SEARch:MODE?',
			':SEARch:EDGE:SOURce?',
			':SEARch:EDGE:SLOPe?',
			':SEARch:EDGE:LEVel?',
		]);
		await assertReadOnly(harness.client, 'get_search');
	});

	it('warns instead of guessing when the scope reports a mode this driver does not type', async () => {
		harness.fake.replies.set(':SEARch:MODE?', 'SERial');
		const result = payload(await call(harness, 'get_search'));
		expect(result.mode).toBeEqual({ raw: 'SERial' });
		expect(warnings(result).some((warning) => warning.includes('unsupported search mode'))).toBeTruthy();
		assertSent(harness.fake, [':SEARch?', ':SEARch:MODE?']);
		harness.fake.replies.set(':SEARch:MODE?', 'EDGE');
	});

	it('sends the state and the mode before the parameters they give a meaning, levels and times as NR3', async () => {
		harness.fake.replies.set(':SEARch:MODE?', 'RUNT');
		const result = payload(
			await call(harness, 'configure_search', {
				search: true,
				mode: 'RUNT',
				source: 'C2',
				polarity: 'NEGative',
				level_high: 0.5,
				level_low: -0.5,
				limit: 'INNer',
				time_lower: 1e-8,
				time_upper: 3e-8,
			}),
		);
		expect(result.commands).toBeEqual([
			':SEARch ON',
			':SEARch:MODE RUNT',
			':SEARch:RUNT:SOURce C2',
			':SEARch:RUNT:POLarity NEGative',
			':SEARch:RUNT:HLEVel 5.00E-01',
			':SEARch:RUNT:LLEVel -5.00E-01',
			':SEARch:RUNT:LIMit INNer',
			':SEARch:RUNT:TLOWer 1.00E-08',
			':SEARch:RUNT:TUPPer 3.00E-08',
		]);
		assertSent(harness.fake, [
			...(result.commands as string[]),
			':SEARch?',
			':SEARch:MODE?',
			':SEARch:RUNT:SOURce?',
			':SEARch:RUNT:POLarity?',
			':SEARch:RUNT:HLEVel?',
			':SEARch:RUNT:LLEVel?',
			':SEARch:RUNT:LIMit?',
			':SEARch:RUNT:TLOWer?',
			':SEARch:RUNT:TUPPer?',
		]);
		expect(warnings(result)).toBeEqual([]);
		harness.fake.replies.set(':SEARch:MODE?', 'EDGE');
	});

	it('reads back only the settings the request named', async () => {
		const result = payload(await call(harness, 'configure_search', { search: true }));
		assertSent(harness.fake, [':SEARch ON', ':SEARch?']);
		expect(result.state).toBeEqual({ search: true });
	});

	it('refuses a parameter the selected mode does not have', async () => {
		await assertInvalidSendsNothing(harness, 'configure_search', { mode: 'EDGE', polarity: 'POSitive' });
	});

	it('refuses a parameter without the mode it belongs to, and a request that names nothing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_search', { level: 0.5 });
		await assertInvalidSendsNothing(harness, 'configure_search', {});
	});

	it('refuses an unordered level pair, an unusable time bound and an unknown field', async () => {
		await assertInvalidSendsNothing(harness, 'configure_search', {
			mode: 'RUNT',
			level_high: -1,
			level_low: 1,
		});
		await assertInvalidSendsNothing(harness, 'configure_search', {
			mode: 'PULSE',
			limit: 'LESSthan',
			time_lower: 1e-8,
		});
		await assertInvalidSendsNothing(harness, 'configure_search', { mode: 'EDGE', levl: 0.5 });
	});

	it('refuses a digital source for a mode the guide gives analog channels alone', async () => {
		await assertInvalidSendsNothing(harness, 'configure_search', { mode: 'RUNT', source: 'D3' });
	});

	it('counts the events on screen and the one in its center', async () => {
		const result = payload(await call(harness, 'read_search_events'));
		expect(result).toBeEqual({ search: true, events: 10, centered_event: 5 });
		assertSent(harness.fake, [':SEARch?', ':SEARch:COUNt?', ':SEARch:EVENt?']);
		await assertReadOnly(harness.client, 'read_search_events');
	});

	it('asks for no count while the search function is off', async () => {
		harness.fake.replies.set(':SEARch?', 'OFF');
		const result = payload(await call(harness, 'read_search_events'));
		expect(result.search).toBeEqual(false);
		expect(result.events).toBe(undefined);
		expect(warnings(result).some((warning) => warning.includes('search function is off'))).toBeTruthy();
		assertSent(harness.fake, [':SEARch?']);
		harness.fake.replies.set(':SEARch?', 'ON');
	});

	it('keeps the raw text of a count the scope answers with no number', async () => {
		harness.fake.replies.set(':SEARch:COUNt?', '****');
		const result = payload(await call(harness, 'read_search_events'));
		expect(result.events).toBeEqual({ raw: '****' });
		expect(warnings(result).some((warning) => warning.includes('search event count'))).toBeTruthy();
		harness.fake.replies.set(':SEARch:COUNt?', '10');
		harness.fake.sent();
	});

	it('copies the settings between the search and the trigger as a destructive call', async () => {
		const result = payload(await call(harness, 'copy_search_settings', { direction: 'TOTRigger' }));
		expect(result.commands).toBeEqual([':SEARch:COPY TOTRigger']);
		expect(result.write_only).toBeEqual([':SEARch:COPY']);
		assertSent(harness.fake, [':SEARch:COPY TOTRigger']);
		const { tools } = await harness.client.listTools();
		expect(tools.find(({ name }) => name === 'copy_search_settings')?.annotations?.destructiveHint).toBe(true);
		await assertInvalidSendsNothing(harness, 'copy_search_settings', { direction: 'BOTH' });
	});

	it('refuses a channel the model does not have', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			const result = await call(two, 'configure_search', { mode: 'EDGE', source: 'C4' });
			expect(result.isError).toBe(true);
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});
});
