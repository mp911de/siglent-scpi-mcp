import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const replies = {
	'INR?': 'INR 8193',
	'BUZZ?': 'ON',
	'SCSV?': '10MIN',
	'EMOD?': 'AutoSetup,OFF;Measure,ON;Cursors,ON;',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const warnings = (result: Awaited<ReturnType<Harness['client']['callTool']>>): string[] =>
	(payload(result).warnings as string[]) ?? [];

describe('status and system settings tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('decodes the INR bits and keeps the raw response', async () => {
		harness.fake.sent();
		const status = payload(await call(harness, 'read_status_events'));
		assertSent(harness.fake, ['INR?']);
		expect(status.commands).toBeEqual(['INR?']);
		expect(status.events).toBeEqual([
			{ bit: 0, event: 'new_signal_acquired' },
			{ bit: 13, event: 'trigger_ready' },
		]);
		expect(status.unknown_bits).toBeEqual([]);
		expect(status.value).toBe(8193);
		expect(status.raw).toBe('INR 8193');
		expect(status.cleared).toBe(true);
	});

	it('preserves bits the guide does not define', async () => {
		harness.fake.replies.set('INR?', 'INR 32800');
		try {
			const status = payload(await call(harness, 'read_status_events'));
			expect(status.events).toBeEqual([]);
			expect(status.unknown_bits).toBeEqual([5, 15]);
			expect(status.value).toBe(32800);
		} finally {
			harness.fake.replies.set('INR?', replies['INR?']);
		}
	});

	it('rejects a response that is not a register value', async () => {
		harness.fake.replies.set('INR?', 'INR');
		try {
			const result = await call(harness, 'read_status_events');
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toMatchRegex(/invalid status event register/);
		} finally {
			harness.fake.replies.set('INR?', replies['INR?']);
		}
	});

	it('advertises INR? as neither read-only nor idempotent, because it clears the register', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'read_status_events')?.annotations;
		expect(annotations).toBeTruthy();
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.idempotentHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(false);
		expect(tools.find((tool) => tool.name === 'read_status_events')?.description ?? '').toMatchRegex(
			/clears the event register/,
		);
	});

	it('reads buzzer, screensaver and the all-function education response', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_system_settings'));
		assertSent(harness.fake, ['BUZZ?', 'SCSV?', 'EMOD?']);
		expect(state.buzzer).toBe(true);
		expect(state.screensaver).toBe('10MIN');
		expect(state.autosetup_enabled).toBe(false);
		expect(state.measure_enabled).toBe(true);
		expect(state.cursors_enabled).toBe(true);
		expect(state.education_mode_raw).toBe(replies['EMOD?']);
		await assertReadOnly(harness.client, 'get_system_settings');
	});

	it('parses the one-function education response too', async () => {
		harness.fake.replies.set('EMOD?', 'EduMode AutoSetup,ON;');
		try {
			const state = payload(await call(harness, 'get_system_settings'));
			expect(state.autosetup_enabled).toBe(true);
			expect(state.measure_enabled).toBe(undefined);
			expect(state.education_mode_raw).toBe('EduMode AutoSetup,ON;');
		} finally {
			harness.fake.replies.set('EMOD?', replies['EMOD?']);
		}
	});

	it('writes one command per setting and one EMOD per function, then reads back', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_system_settings', {
				buzzer: true,
				screensaver: '10MIN',
				autosetup_enabled: false,
				measure_enabled: true,
				cursors_enabled: true,
			}),
		);
		expect(result.commands).toBeEqual([
			'BUZZ ON',
			'SCSV 10MIN',
			'EMOD AutoSetup,OFF',
			'EMOD Measure,ON',
			'EMOD Cursors,ON',
		]);
		assertSent(harness.fake, [...(result.commands as string[]), 'BUZZ?', 'SCSV?', 'EMOD?']);
		expect((result.state as Record<string, unknown>).screensaver).toBe('10MIN');
	});

	it('accepts each setting on its own', async () => {
		const screensaver = payload(await call(harness, 'configure_system_settings', { screensaver: '10MIN' }));
		expect(screensaver.commands).toBeEqual(['SCSV 10MIN']);

		const cursors = payload(await call(harness, 'configure_system_settings', { cursors_enabled: false }));
		expect(cursors.commands).toBeEqual(['EMOD Cursors,OFF']);
	});

	it('reports a setting the scope did not take', async () => {
		const result = await call(harness, 'configure_system_settings', { screensaver: '5MIN', cursors_enabled: false });
		expect(
			warnings(result).some(
				(warning) => warning.includes('screensaver was set to "5MIN"') && warning.includes('10MIN'),
			),
		).toBeTruthy();
		expect(warnings(result).some((warning) => warning.includes('cursors_enabled was set to false'))).toBeTruthy();
	});

	it('rejects values outside the guide sets without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { screensaver: '2MIN' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { screensaver: 'ON' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { buzzer: 'ON' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { autosetup_enabled: 'LOCKED' });
	});

	it('refuses an empty configuration', async () => {
		const result = await call(harness, 'configure_system_settings');
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toMatchRegex(/at least one setting/);
	});

	it('sends nothing to a newer-dialect model', async () => {
		const other = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2104X Plus,SN,1.0.0' });
		try {
			for (const name of ['read_status_events', 'get_system_settings']) {
				assertCapabilityError(await other.client.callTool({ name, arguments: {} }), 'SDS2104X Plus');
			}
			expect(other.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await other.close();
		}
	});
});
