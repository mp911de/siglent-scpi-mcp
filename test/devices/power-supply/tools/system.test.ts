import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { powerSupply } from '../../../../src/devices/power-supply/driver.ts';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type SupplyHarness, startSupplyHarness } from '../../../support/harness.ts';

const call = (harness: SupplyHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

async function connect(model: string, replies: Record<string, Reply> = {}): Promise<SupplyHarness> {
	const harness = await startSupplyHarness(model, replies);
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('system tools on SPD1168X', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD1168X', {
			'SYSTem:VERSion?': '2.01.01.06',
			'INSTrument?': 'CH1',
			'SYSTem:STATus?': '0x0224',
		});
	});

	after(() => harness.close());

	it('identifies with a plain *IDN? handshake, no CHDR, and reports the capabilities', async () => {
		const identity = payload(await call(harness, 'identify'));
		expect(identity.model).toBe('SPD1168X');
		const capabilities = identity.capabilities as Record<string, unknown>;
		expect(capabilities.set).toBe('SPD1000X');
		expect(capabilities.channels).toBe(1);
		assertSent(harness.fake, ['*IDN?']);
		await assertReadOnly(harness.client, 'identify');
	});

	it('decodes SYSTem:STATus? with the SPD1000X bit layout', async () => {
		const status = payload(await call(harness, 'get_power_status'));
		expect(status).toBeEqual({
			status: { mode: 'CV', output: false, wire_mode: '4W', timer: false, display: 'digital', raw: '0x0224' },
			selected_channel: 'CH1',
			version: '2.01.01.06',
		});
		assertSent(harness.fake, ['SYSTem:VERSion?', 'INSTrument?', 'SYSTem:STATus?']);
		await assertReadOnly(harness.client, 'get_power_status');
	});

	it('saves, recalls and deletes a state only with the matching acknowledgement', async () => {
		const saved = payload(await call(harness, 'save_state', { slot: 3, confirm_overwrite: true }));
		expect(saved).toBeEqual({ commands: ['*SAV 3'], write_only: ['*SAV'] });
		const recalled = payload(await call(harness, 'recall_state', { slot: 3, confirm_recall: true }));
		expect(recalled.commands).toBeEqual(['*RCL 3']);
		const deleted = payload(await call(harness, 'delete_state', { slot: 3, confirm_delete: true }));
		expect(deleted.commands).toBeEqual(['*DEL 3']);
		assertSent(harness.fake, ['*SAV 3', '*RCL 3', '*DEL 3']);
		await assertInvalidSendsNothing(harness, 'save_state', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'recall_state', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'delete_state', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'save_state', { slot: 6, confirm_overwrite: true });
	});

	it('locks and unlocks the front panel', async () => {
		const locked = payload(await call(harness, 'lock_front_panel', { locked: true }));
		expect(locked).toBeEqual({ commands: ['*LOCK'], write_only: ['*LOCK'] });
		const unlocked = payload(await call(harness, 'lock_front_panel', { locked: false }));
		expect(unlocked.commands).toBeEqual(['*UNLOCK']);
		assertSent(harness.fake, ['*LOCK', '*UNLOCK']);
	});

	it('hides lock_front_panel unless the server enables locking', async () => {
		const hidden = await startSupplyHarness('SPD1168X', {}, undefined, { enableLock: false });
		try {
			const names = (await hidden.client.listTools()).tools.map(({ name }) => name);
			expect(names.includes('lock_front_panel')).toBe(false);
			expect(names.includes('get_output')).toBe(true);
		} finally {
			await hidden.close();
		}
	});

	it('sends the unlock on connect only when the intent asks for it', async () => {
		await powerSupply.prepare?.(harness.supply, { unlock: false, allowLock: false });
		assertSent(harness.fake, []);
		await powerSupply.prepare?.(harness.supply, { unlock: true, allowLock: false });
		await harness.fake.until('*UNLOCK');
		assertSent(harness.fake, ['*UNLOCK']);
	});

	it('serves raw SCPI with single-line validation', async () => {
		harness.fake.replies.set('SYSTem:ERRor?', '0 No Error');
		const queried = payload(await call(harness, 'scpi_query', { command: 'SYSTem:ERRor?' }));
		expect(queried.response).toBe('0 No Error');
		const sent = payload(await call(harness, 'scpi_command', { command: 'OUTPut CH1,OFF' }));
		expect(sent.commands).toBeEqual(['OUTPut CH1,OFF']);
		assertSent(harness.fake, ['SYSTem:ERRor?', 'OUTPut CH1,OFF']);
		await assertInvalidSendsNothing(harness, 'scpi_query', { command: 'OUTPut CH1,OFF' });
		await assertInvalidSendsNothing(harness, 'scpi_command', { command: 'SYSTem:ERRor?' });
	});
});

describe('system tools on SPD3303C', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD3303C', {
			'SYSTem:VERSion?': '1.01.01.02',
			'INSTrument?': 'CH1',
			'SYSTem:STATus?': '0x0224',
		});
	});

	after(() => harness.close());

	it('decodes SYSTem:STATus? with the SPD3303 bit layout', async () => {
		const status = payload(await call(harness, 'get_power_status'));
		expect(status.status).toBeEqual({
			ch1_mode: 'CV',
			ch2_mode: 'CV',
			track: 'independent',
			ch1_output: false,
			ch2_output: true,
			raw: '0x0224',
		});
	});

	it('refuses *DEL before anything is written', async () => {
		harness.fake.sent();
		const result = await call(harness, 'delete_state', { slot: 1, confirm_delete: true });
		assertCapabilityError(result, 'SPD3303C');
		assertSent(harness.fake, []);
	});
});

describe('system tools on an unknown SPD model', () => {
	let harness: SupplyHarness;

	before(async () => {
		harness = await connect('SPD4000', { 'SYSTem:VERSion?': '1.0', 'INSTrument?': 'CH1', 'SYSTem:STATus?': '0x0224' });
	});

	after(() => harness.close());

	it('still attempts state operations, with the unknown-set warning', async () => {
		const saved = payload(await call(harness, 'save_state', { slot: 1, confirm_overwrite: true }));
		expect(saved.commands).toBeEqual(['*SAV 1']);
		expect((saved.warnings as string[]).some((warning) => warning.includes('command support is unknown'))).toBeTruthy();
	});
});
