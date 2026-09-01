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
	'DTJN?': 'OFF',
	'GRDS?': 'FULL',
	'MENU?': 'ON',
	'PESU?': 'INFINITE',
	'INTS?': 'TRACE,50,GRID,75',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const warnings = (result: Awaited<ReturnType<Harness['client']['callTool']>>): string[] =>
	(payload(result).warnings as string[]) ?? [];

describe('display tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the display state and parses INTS? by key, not by position', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_display'));
		assertSent(harness.fake, ['DTJN?', 'GRDS?', 'MENU?', 'PESU?', 'INTS?']);
		expect(state.join_points).toBe(true);
		expect(state.grid).toBe('FULL');
		expect(state.menu).toBe(true);
		expect(state.persistence).toBe('INFINITE');
		expect(state.grid_intensity).toBe(75);
		expect(state.trace_intensity).toBe(50);
		expect(state.intensity_raw).toBe('TRACE,50,GRID,75');
		await assertReadOnly(harness.client, 'get_display');
	});

	it('sends DTJN inverted: joined points are DTJN OFF, dots are DTJN ON', async () => {
		harness.fake.sent();
		const joined = payload(await call(harness, 'configure_display', { join_points: true }));
		expect(joined.commands).toBeEqual(['DTJN OFF']);
		expect(harness.fake.sent()[0]).toBe('DTJN OFF');

		const dots = payload(await call(harness, 'configure_display', { join_points: false }));
		expect(dots.commands).toBeEqual(['DTJN ON']);
		expect(harness.fake.sent()[0]).toBe('DTJN ON');
	});

	it('writes grid, menu and persistence one command each and reads them back', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_display', { grid: 'FULL', menu: true, persistence: 'INFINITE' }),
		);
		expect(result.commands).toBeEqual(['GRDS FULL', 'MENU ON', 'PESU INFINITE']);
		assertSent(harness.fake, ['GRDS FULL', 'MENU ON', 'PESU INFINITE', 'GRDS?', 'MENU?', 'PESU?']);
		expect((result.state as Record<string, unknown>).persistence).toBe('INFINITE');
	});

	it('accepts each intensity field independently in one INTS command', async () => {
		harness.fake.sent();
		const grid = payload(await call(harness, 'configure_display', { grid_intensity: 75 }));
		expect(grid.commands).toBeEqual(['INTS GRID,75']);
		expect(harness.fake.sent()[0]).toBe('INTS GRID,75');

		const trace = payload(await call(harness, 'configure_display', { trace_intensity: 50 }));
		expect(trace.commands).toBeEqual(['INTS TRACE,50']);

		const both = payload(await call(harness, 'configure_display', { grid_intensity: 75, trace_intensity: 50 }));
		expect(both.commands).toBeEqual(['INTS GRID,75,TRACE,50']);
	});

	it('warns about the model-dependent minimum and reports what the scope kept', async () => {
		const result = await call(harness, 'configure_display', { grid_intensity: 20 });
		const reported = warnings(result);
		expect(
			reported.some((warning) => /below 30 may be clamped/.test(warning) && warning.includes('grid_intensity')),
		).toBeTruthy();
		expect(
			reported.some((warning) => warning.includes('grid_intensity was set to 20') && warning.includes('75')),
		).toBeTruthy();
	});

	it('does not call an E-notation read-back a clamp', async () => {
		harness.fake.replies.set('PESU?', 'PESU 5.0E+00');
		try {
			const result = await call(harness, 'configure_display', { persistence: 5 });
			expect(payload(result).commands).toBeEqual(['PESU 5']);
			expect(warnings(result)).toBeEqual([]);
		} finally {
			harness.fake.replies.set('PESU?', replies['PESU?']);
		}
	});

	it('rejects values outside the guide sets without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_display', { grid: 'DOTTED' });
		await assertInvalidSendsNothing(harness, 'configure_display', { grid_intensity: 101 });
		await assertInvalidSendsNothing(harness, 'configure_display', { trace_intensity: -1 });
		await assertInvalidSendsNothing(harness, 'configure_display', { persistence: 3 });
		await assertInvalidSendsNothing(harness, 'configure_display', { persistence: 'INFINITY' });
	});

	it('refuses an empty configuration', async () => {
		const result = await call(harness, 'configure_display');
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toMatchRegex(/Provide at least one setting to configure/);
	});

	it('accepts persistence OFF on SDS1000X-E and refuses it elsewhere without writing', async () => {
		expect(payload(await call(harness, 'configure_display', { persistence: 'OFF' })).commands).toBeEqual(['PESU OFF']);

		const other = await startHarness({
			...replies,
			'*IDN?': 'Siglent Technologies,SDS1104X+,SDS1EBAC0L0001,7.6.1.20',
		});
		try {
			const result = await other.client.callTool({
				name: 'configure_display',
				arguments: { persistence: 'OFF', grid: 'HALF' },
			});
			assertCapabilityError(result, 'SDS1104X\\+');
			expect(other.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await other.close();
		}
	});
});
