import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertCapabilityError, assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import { type SupplyHarness, startSupplyHarness } from '../../../support/harness.ts';

const call = (harness: SupplyHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('protection tools', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await startSupplyHarness('SPD1168X', { 'OVP?': '16.500', 'OCP?': '8.200' });
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('sets OVP and OCP as plain decimals and reads back what it set', async () => {
		const result = payload(await call(harness, 'configure_protection', { over_voltage: 16.5, over_current: 8.2 }));
		expect(result.commands).toBeEqual(['OVP 16.500', 'OCP 8.200']);
		expect(result.state).toBeEqual({
			over_voltage: { value: 16.5, raw: '16.500' },
			over_current: { value: 8.2, raw: '8.200' },
		});
		assertSent(harness.fake, ['OVP 16.500', 'OCP 8.200', 'OVP?', 'OCP?']);
	});

	it('clears the protection pop-up with the command-only OUTPut:RESEt:PROTect', async () => {
		const result = payload(await call(harness, 'clear_protection'));
		expect(result).toBeEqual({ commands: ['OUTPut:RESEt:PROTect'], write_only: ['OUTPut:RESEt:PROTect'] });
		assertSent(harness.fake, ['OUTPut:RESEt:PROTect']);
	});

	it('sends nothing on invalid input', async () => {
		await assertInvalidSendsNothing(harness, 'configure_protection', { over_voltage: -1 });
		await assertInvalidSendsNothing(harness, 'configure_protection', {});
	});

	it('refuses the whole subsystem on the SPD3303 set before anything is sent', async () => {
		const spd3303 = await startSupplyHarness('SPD3303C');
		try {
			await call(spd3303, 'identify');
			spd3303.fake.sent();
			assertCapabilityError(await call(spd3303, 'configure_protection', { over_voltage: 16 }), 'SPD3303C');
			assertCapabilityError(await call(spd3303, 'clear_protection'), 'SPD3303C');
			assertSent(spd3303.fake, []);
		} finally {
			await spd3303.close();
		}
	});
});
