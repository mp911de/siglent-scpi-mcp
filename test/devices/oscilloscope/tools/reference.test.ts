import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const replies = {
	'REFLA?': 'REFLA REFA',
	'REFSR?': 'REFSR C1',
	'REFDS?': 'REFDS ON',
	'REFSC?': 'REFSC 1.00E-01V',
	'REFPO?': 'REFPO 2.00E-01V',
};

const readback = ['REFLA?', 'REFSR?', 'REFDS?', 'REFSC?', 'REFPO?'];

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const annotations = async (harness: Harness, name: string) => {
	const { tools } = await harness.client.listTools();
	return tools.find((tool) => tool.name === name)?.annotations;
};

const saving = { location: 'REFA', save: true, confirm_overwrite_reference: true };

describe('reference tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the location, source, display, scale and position', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_reference'));
		assertSent(harness.fake, readback);
		expect(state.location).toBe('REFA');
		expect(state.source).toBe('C1');
		expect(state.display).toBe('ON');
		expect(state.vertical_scale).toBeEqual({ value: 0.1, unit: 'V', raw: 'REFSC 1.00E-01V' });
		expect(state.vertical_position).toBeEqual({ value: 0.2, unit: 'V', raw: 'REFPO 2.00E-01V' });
		expect(state.write_only).toBeEqual(['REFCL', 'REFSA']);
		await assertReadOnly(harness.client, 'get_reference');
	});

	it('selects the location and the source before saving, then reads the state back', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_reference', { ...saving, source: 'C1', display: true }));
		const commands = ['REFLA REFA', 'REFSR C1', 'REFSA', 'REFDS ON'];
		expect(result.commands).toBeEqual(commands);
		assertSent(harness.fake, [...commands, 'REFLA?', 'REFSR?', 'REFDS?']);
		expect(result.warnings).toBe(undefined);
	});

	it('sends the scale and the position after the save, in guide order', async () => {
		harness.fake.replies.set('REFSR?', 'REFSR MATH');
		try {
			harness.fake.sent();
			const result = payload(
				await call(harness, 'configure_reference', {
					...saving,
					source: 'MATH',
					display: true,
					vertical_position: '0.2V',
					vertical_scale: '100mV',
				}),
			);
			const commands = ['REFLA REFA', 'REFSR MATH', 'REFSA', 'REFDS ON', 'REFSC 100mV', 'REFPO 0.2V'];
			expect(result.commands).toBeEqual(commands);
			assertSent(harness.fake, [...commands, ...readback]);
			expect(result.warnings).toBe(undefined);
		} finally {
			harness.fake.replies.set('REFSR?', replies['REFSR?']);
		}
	});

	it('marks the save destructive and requires an explicit acknowledgement and a location', async () => {
		const hints = await annotations(harness, 'configure_reference');
		expect(hints?.readOnlyHint).toBe(false);
		expect(hints?.destructiveHint).toBe(true);
		await assertInvalidSendsNothing(harness, 'configure_reference', { location: 'REFA', save: true });
		await assertInvalidSendsNothing(harness, 'configure_reference', {
			save: true,
			confirm_overwrite_reference: true,
		});
	});

	it('reads REFDS? before the scale and refuses it when the reference is not shown', async () => {
		harness.fake.replies.set('REFDS?', 'REFDS OFF');
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_reference', { vertical_scale: '1V' });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(/not displayed.*`display: true` or `save: true`/s);
			assertSent(harness.fake, ['REFDS?']);
		} finally {
			harness.fake.replies.set('REFDS?', replies['REFDS?']);
		}
	});

	it('discloses the selection it already applied when the guard rejects the request', async () => {
		harness.fake.replies.set('REFDS?', 'REFDS OFF');
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_reference', {
				location: 'REFB',
				source: 'C2',
				vertical_scale: '1V',
			});
			expect(result.isError).toBe(true);
			expect(payload(result).commands).toBeEqual(['REFLA REFB', 'REFSR C2', 'REFDS?']);
			assertSent(harness.fake, ['REFLA REFB', 'REFSR C2', 'REFDS?']);
		} finally {
			harness.fake.replies.set('REFDS?', replies['REFDS?']);
		}
	});

	it('selects the location before asking whether that reference is shown', async () => {
		harness.fake.replies.set('REFDS?', 'REFDS OFF');
		try {
			harness.fake.sent();
			const result = payload(
				await call(harness, 'configure_reference', { location: 'REFB', display: true, vertical_scale: '1V' }),
			);
			assertSent(harness.fake, ['REFLA REFB', 'REFDS?', 'REFDS ON', 'REFSC 1V', 'REFLA?', 'REFDS?', 'REFSC?']);
			expect(
				(result.warnings as string[]).some((warning) => warning.includes('save command has no query form')),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set('REFDS?', replies['REFDS?']);
		}
	});

	it('sends the settings unchecked with a warning when REFDS? is not a state', async () => {
		harness.fake.replies.set('REFDS?', 'REFDS ?');
		try {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_reference', { display: true }));
			assertSent(harness.fake, ['REFDS?', 'REFDS ON', 'REFDS?']);
			expect((result.warnings as string[]).some((warning) => warning.includes('unchecked'))).toBeTruthy();
		} finally {
			harness.fake.replies.set('REFDS?', replies['REFDS?']);
		}
	});

	it('skips the precondition query when the same request saves', async () => {
		harness.fake.replies.set('REFDS?', 'REFDS OFF');
		try {
			harness.fake.sent();
			await call(harness, 'configure_reference', { ...saving, vertical_scale: '500uV' });
			assertSent(harness.fake, ['REFLA REFA', 'REFSA', 'REFSC 500uV', 'REFLA?', 'REFSC?']);
		} finally {
			harness.fake.replies.set('REFDS?', replies['REFDS?']);
		}
	});

	it('warns about a position the scope clamped', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_reference', { vertical_position: '5V' }));
		expect(result.commands).toBeEqual(['REFPO 5V']);
		expect(
			(result.warnings as string[]).some((warning) => warning.startsWith('vertical_position was set to "5V"')),
		).toBeTruthy();
	});

	it('does not call a zero position clamped when the scope reports zero back', async () => {
		harness.fake.replies.set('REFPO?', 'REFPO 0.00E+00V');
		try {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_reference', { vertical_position: '0V' }));
			assertSent(harness.fake, ['REFDS?', 'REFPO 0V', 'REFPO?']);
			expect(result.warnings).toBe(undefined);
		} finally {
			harness.fake.replies.set('REFPO?', replies['REFPO?']);
		}
	});

	it('warns about a zero position the scope did not take', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_reference', { vertical_position: '0V' }));
		expect(
			(result.warnings as string[]).some((warning) => warning.startsWith('vertical_position was set to "0V"')),
		).toBeTruthy();
	});

	it('rejects values outside the guide sets without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_reference', { location: 'REFE' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { source: 'C5' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { source: 'D0' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { vertical_scale: '20V' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { vertical_scale: '100uV' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { vertical_scale: '1S' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { vertical_position: '2ms' });
		await assertInvalidSendsNothing(harness, 'configure_reference', { vertical_position: 'DROP TABLE' });
	});

	it('refuses an empty configuration', async () => {
		const result = await call(harness, 'configure_reference');
		expect(result.isError).toBe(true);
		expect(text(result)).toMatchRegex(/Provide at least one setting/);
	});

	it('closes the reference function and reports the command', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'close_reference'));
		assertSent(harness.fake, ['REFCL']);
		expect(result.commands).toBeEqual(['REFCL']);
		const hints = await annotations(harness, 'close_reference');
		expect(hints?.readOnlyHint).toBe(false);
		expect(hints?.destructiveHint).toBe(true);
	});

	it('rejects a channel the model does not have and allows MATH', async () => {
		const two = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0098,7.6.1.20' });
		try {
			await two.client.callTool({ name: 'identify', arguments: {} });
			two.fake.sent();
			assertCapabilityError(
				await two.client.callTool({ name: 'configure_reference', arguments: { source: 'C4' } }),
				'SDS1202X-E',
			);
			assertSent(two.fake, []);

			const result = payload(await two.client.callTool({ name: 'configure_reference', arguments: { source: 'MATH' } }));
			expect(result.commands).toBeEqual(['REFSR MATH']);
			assertSent(two.fake, ['REFSR MATH', 'REFSR?']);
		} finally {
			await two.close();
		}
	});

	it('refuses the families the guide lists as unsupported, writing nothing', async () => {
		const older = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2304X,SDS2X0001,1.2.3' });
		try {
			await older.client.callTool({ name: 'identify', arguments: {} });
			older.fake.sent();
			for (const name of ['get_reference', 'close_reference']) {
				assertCapabilityError(await older.client.callTool({ name, arguments: {} }), 'SDS2304X');
			}
			assertCapabilityError(
				await older.client.callTool({ name: 'configure_reference', arguments: { location: 'REFA' } }),
				'SDS2304X',
			);
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('refuses the newer SCPI dialect', async () => {
		const newer = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2504X HD,SDS2X0001,1.2.3' });
		try {
			assertCapabilityError(await newer.client.callTool({ name: 'get_reference', arguments: {} }), 'SDS2504X HD');
			expect(newer.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await newer.close();
		}
	});
});
