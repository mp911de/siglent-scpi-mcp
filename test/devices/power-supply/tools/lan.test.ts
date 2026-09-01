import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertCapabilityError, assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type SupplyHarness, startSupplyHarness } from '../../../support/harness.ts';

const call = (harness: SupplyHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	'DHCP?': 'OFF',
	'IPaddr?': '10.11.13.214',
	'MASKaddr?': '255.255.255.0',
	'GATEaddr?': '10.11.13.1',
};

async function connect(extra: Record<string, Reply> = {}): Promise<SupplyHarness> {
	const harness = await startSupplyHarness('SPD1168X', { ...replies, ...extra });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('configure_lan', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('sets netmask, gateway and DHCP OFF first, reading back the documented queries', async () => {
		const result = payload(
			await call(harness, 'configure_lan', {
				netmask: '255.255.255.0',
				gateway: '10.11.13.1',
				dhcp: false,
				confirm_network: true,
			}),
		);
		expect(result.commands).toBeEqual(['DHCP OFF', 'MASKaddr 255.255.255.0', 'GATEaddr 10.11.13.1']);
		expect(result.state).toBeEqual({ netmask: '255.255.255.0', gateway: '10.11.13.1', dhcp: 'OFF' });
		assertSent(harness.fake, [
			'DHCP?',
			'DHCP OFF',
			'MASKaddr 255.255.255.0',
			'GATEaddr 10.11.13.1',
			'MASKaddr?',
			'GATEaddr?',
			'DHCP?',
		]);
	});

	it('does not send an address the supply already has', async () => {
		const result = payload(await call(harness, 'configure_lan', { address: '10.11.13.214', confirm_network: true }));
		expect(result.commands).toBeEqual([]);
		expect(result.changed).toBe(false);
		assertSent(harness.fake, ['DHCP?', 'IPaddr?']);
	});

	it('warns that static addresses are ignored while DHCP stays ON', async () => {
		harness.fake.replies.set('DHCP?', 'ON');
		const result = payload(await call(harness, 'configure_lan', { netmask: '255.255.255.0', confirm_network: true }));
		expect(
			(result.warnings as string[]).some((warning) => warning.includes('ignored while DHCP is enabled')),
		).toBeTruthy();
		harness.fake.replies.set('DHCP?', 'OFF');
		harness.fake.sent();
	});

	it('sends nothing on invalid input', async () => {
		await assertInvalidSendsNothing(harness, 'configure_lan', { netmask: '255.255.255.0' });
		await assertInvalidSendsNothing(harness, 'configure_lan', { confirm_network: true });
		await assertInvalidSendsNothing(harness, 'configure_lan', { address: '10.11.13', confirm_network: true });
		await assertInvalidSendsNothing(harness, 'configure_lan', {
			address: '10.11.13.5',
			dhcp: true,
			confirm_network: true,
		});
	});

	it('writes a new address last and retires the connection without a read-back', async () => {
		const fresh = await connect();
		try {
			const result = payload(await call(fresh, 'configure_lan', { address: '10.11.0.50', confirm_network: true }));
			expect(result.commands).toBeEqual(['IPaddr 10.11.0.50']);
			expect(result.changed).toBe(true);
			expect(result.previous).toBe('10.11.13.214');
			expect(result.connection).toBe('retired');
			assertSent(fresh.fake, ['DHCP?', 'IPaddr?', 'IPaddr 10.11.0.50']);
			const refused = await call(fresh, 'get_power_status');
			expect(refused.isError).toBe(true);
			assertSent(fresh.fake, []);
		} finally {
			await fresh.close();
		}
	});

	it('refuses LAN configuration on the SPD3303 set before anything is sent', async () => {
		const spd3303 = await startSupplyHarness('SPD3303C');
		try {
			await call(spd3303, 'identify');
			spd3303.fake.sent();
			assertCapabilityError(
				await call(spd3303, 'configure_lan', { address: '10.11.0.50', confirm_network: true }),
				'SPD3303C',
			);
			assertSent(spd3303.fake, []);
		} finally {
			await spd3303.close();
		}
	});
});
