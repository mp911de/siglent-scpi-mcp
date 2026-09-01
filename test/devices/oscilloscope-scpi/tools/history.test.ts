import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import type { ToolError } from '../../../../src/tools/define.ts';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness, text } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':HISTORy?': 'ON',
	':HISTORy:FRAMe?': '4',
	':HISTORy:INTERval?': '1.00E-03',
	':HISTORy:LIST?': 'ON,TIME',
	':HISTORy:PLAY?': 'PAUSe',
	':HISTORy:TIME?': '07:48:09.253827',
};

describe('EN11F history tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole history state with the frame timestamp', async () => {
		const state = payload(await call(harness, 'get_history'));
		expect(state).toBeEqual({
			enabled: true,
			frame: 4,
			interval: { value: 1e-3, raw: '1.00E-03' },
			list: true,
			list_type: 'TIME',
			list_raw: 'ON,TIME',
			play: 'PAUSe',
			timestamp: { hour: 7, minute: 48, second: 9, microsecond: 253827, raw: '07:48:09.253827' },
		});
		assertSent(harness.fake, [
			':HISTORy?',
			':HISTORy:FRAMe?',
			':HISTORy:INTERval?',
			':HISTORy:LIST?',
			':HISTORy:PLAY?',
			':HISTORy:TIME?',
		]);
		await assertReadOnly(harness.client, 'get_history');
	});

	it('reads only the mode while history is off, with a warning', async () => {
		harness.fake.replies.set(':HISTORy?', 'OFF');
		try {
			const state = payload(await call(harness, 'get_history'));
			expect(state.enabled).toBeEqual(false);
			expect(state.timestamp).toBe(undefined);
			expect((state.warnings as string[]).some((warning) => warning.includes('not on'))).toBeTruthy();
			assertSent(harness.fake, [':HISTORy?']);
		} finally {
			harness.fake.replies.set(':HISTORy?', 'ON');
		}
	});

	it('keeps an unrecognized timestamp as raw text, with a warning', async () => {
		harness.fake.replies.set(':HISTORy:TIME?', 'N/A');
		try {
			const state = payload(await call(harness, 'get_history'));
			expect(state.timestamp).toBeEqual({ raw: 'N/A' });
			expect((state.warnings as string[]).some((warning) => warning.includes('timestamp'))).toBeTruthy();
		} finally {
			harness.fake.replies.set(':HISTORy:TIME?', '07:48:09.253827');
			harness.fake.sent();
		}
	});

	it('enables history before the frame and reads back what it set', async () => {
		const result = payload(
			await call(harness, 'configure_history', {
				enabled: true,
				frame: 4,
				interval: 1e-3,
				list: true,
				list_type: 'TIME',
				play: 'PAUSe',
			}),
		);
		expect(result.commands).toBeEqual([
			':HISTORy ON',
			':HISTORy:FRAMe 4',
			':HISTORy:INTERval 1.00E-03',
			':HISTORy:LIST ON,TIME',
			':HISTORy:PLAY PAUSe',
		]);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':HISTORy ON',
			':HISTORy:FRAMe 4',
			':HISTORy:INTERval 1.00E-03',
			':HISTORy:LIST ON,TIME',
			':HISTORy:PLAY PAUSe',
			':HISTORy?',
			':HISTORy:FRAMe?',
			':HISTORy:INTERval?',
			':HISTORy:LIST?',
			':HISTORy:PLAY?',
		]);
	});

	it('checks the mode first when a frame is selected without enabling', async () => {
		harness.fake.replies.set(':HISTORy:FRAMe?', '2');
		try {
			const result = payload(await call(harness, 'configure_history', { frame: 2 }));
			expect(result.commands).toBeEqual([':HISTORy:FRAMe 2']);
			expect(result.warnings).toBe(undefined);
			assertSent(harness.fake, [':HISTORy?', ':HISTORy:FRAMe 2', ':HISTORy:FRAMe?']);
		} finally {
			harness.fake.replies.set(':HISTORy:FRAMe?', '4');
		}
	});

	it('refuses a frame while history is off and sends no write', async () => {
		harness.fake.replies.set(':HISTORy?', 'OFF');
		try {
			const result = await call(harness, 'configure_history', { frame: 2 });
			expect(result.isError).toBe(true);
			const error = JSON.parse(text(result)) as ToolError;
			expect(error.kind).toBe('unsupported');
			expect(error.error).toMatchRegex(/History mode is off/);
			assertSent(harness.fake, [':HISTORy?']);
		} finally {
			harness.fake.replies.set(':HISTORy?', 'ON');
		}
	});

	it('warns when the scope clamped the frame', async () => {
		harness.fake.replies.set(':HISTORy:FRAMe?', '7');
		try {
			const result = payload(await call(harness, 'configure_history', { enabled: true, frame: 90 }));
			expect(
				(result.warnings as string[]).some(
					(warning) => warning.includes('frame') && warning.includes('acquisitions in memory'),
				),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set(':HISTORy:FRAMe?', '4');
			harness.fake.sent();
		}
	});

	it('sends nothing for a history setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_history', {});
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: false, frame: 1 });
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: false, play: 'PAUSe' });
		await assertInvalidSendsNothing(harness, 'configure_history', { list_type: 'TIME' });
		await assertInvalidSendsNothing(harness, 'configure_history', { frame: 0 });
		await assertInvalidSendsNothing(harness, 'configure_history', { interval: 2 });
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: true, frames: 1 });
	});
});
