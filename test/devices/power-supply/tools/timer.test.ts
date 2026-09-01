import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertCapabilityError, assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import { type SupplyHarness, startSupplyHarness } from '../../../support/harness.ts';

const call = (harness: SupplyHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('configure_timer', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await startSupplyHarness('SPD1168X', {
			'TIMEr:SET? CH1,1': '3, 0.5, 2',
			'TIMEr:SET? CH1,2': '5, 1, 10',
		});
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('programs the groups, enables the timer last and reads the groups back', async () => {
		const result = payload(
			await call(harness, 'configure_timer', {
				groups: [
					{ group: 1, voltage: 3, current: 0.5, seconds: 2 },
					{ group: 2, voltage: 5, current: 1, seconds: 10 },
				],
				enabled: true,
			}),
		);
		expect(result.commands).toBeEqual([
			'TIMEr:SET CH1,1,3.000,0.500,2.000',
			'TIMEr:SET CH1,2,5.000,1.000,10.000',
			'TIMEr CH1,ON',
		]);
		expect(result.state).toBeEqual({
			group_1: { voltage: 3, current: 0.5, seconds: 2 },
			group_2: { voltage: 5, current: 1, seconds: 10 },
		});
		expect(result.write_only).toBeEqual(['TIMEr']);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			'TIMEr:SET CH1,1,3.000,0.500,2.000',
			'TIMEr:SET CH1,2,5.000,1.000,10.000',
			'TIMEr CH1,ON',
			'TIMEr:SET? CH1,1',
			'TIMEr:SET? CH1,2',
		]);
	});

	it('warns when a value the supply reports differs from the request', async () => {
		const result = payload(
			await call(harness, 'configure_timer', { groups: [{ group: 1, voltage: 4, current: 0.5, seconds: 2 }] }),
		);
		expect(
			(result.warnings as string[]).some((warning) => warning.includes('group 1 voltage was set to 4')),
		).toBeTruthy();
	});

	it('warns when enabling with groups that do not start from 1', async () => {
		const result = payload(
			await call(harness, 'configure_timer', {
				groups: [{ group: 2, voltage: 5, current: 1, seconds: 10 }],
				enabled: true,
			}),
		);
		expect((result.warnings as string[]).some((warning) => warning.includes('start from 1'))).toBeTruthy();
	});

	it('sends nothing on invalid input', async () => {
		await assertInvalidSendsNothing(harness, 'configure_timer', {});
		await assertInvalidSendsNothing(harness, 'configure_timer', {
			groups: [{ group: 6, voltage: 1, current: 1, seconds: 1 }],
		});
		await assertInvalidSendsNothing(harness, 'configure_timer', {
			groups: [
				{ group: 1, voltage: 1, current: 1, seconds: 1 },
				{ group: 1, voltage: 2, current: 2, seconds: 2 },
			],
		});
		await assertInvalidSendsNothing(harness, 'configure_timer', {
			groups: [{ group: 1, voltage: 1, current: 1, seconds: 10_001 }],
		});
	});

	it('refuses the timer on the SPD3303 set before anything is sent', async () => {
		const spd3303 = await startSupplyHarness('SPD3303C');
		try {
			await call(spd3303, 'identify');
			spd3303.fake.sent();
			assertCapabilityError(await call(spd3303, 'configure_timer', { enabled: true }), 'SPD3303C');
			assertSent(spd3303.fake, []);
		} finally {
			await spd3303.close();
		}
	});
});
