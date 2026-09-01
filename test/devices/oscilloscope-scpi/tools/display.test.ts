import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':DISPlay:AXIS?': 'ON',
	':DISPlay:AXIS:MODE?': 'FIXed',
	':DISPlay:BACKlight?': '100',
	':DISPlay:COLor?': 'ON',
	':DISPlay:GRATicule?': '50',
	':DISPlay:GRIDstyle?': 'LIGHt',
	':DISPlay:INTensity?': '75',
	':DISPlay:MENU?': 'FLOating',
	':DISPlay:MENU:HIDE?': '10S',
	':DISPlay:PERSistence?': '5S',
	':DISPlay:TRANsparence?': '80',
	':DISPlay:TYPE?': 'VECTor',
};

describe('EN11F display tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole display state without the handheld transparence', async () => {
		const state = payload(await call(harness, 'get_display'));
		expect(state).toBeEqual({
			axis_labels: true,
			axis_mode: 'FIXed',
			backlight: 100,
			color_grade: true,
			grid_intensity: 50,
			grid: 'LIGHt',
			trace_intensity: 75,
			menu_style: 'FLOating',
			menu_hide: '10S',
			persistence: '5S',
			join_points: true,
		});
		assertSent(harness.fake, [
			':DISPlay:AXIS?',
			':DISPlay:AXIS:MODE?',
			':DISPlay:BACKlight?',
			':DISPlay:COLor?',
			':DISPlay:GRATicule?',
			':DISPlay:GRIDstyle?',
			':DISPlay:INTensity?',
			':DISPlay:MENU?',
			':DISPlay:MENU:HIDE?',
			':DISPlay:PERSistence?',
			':DISPlay:TYPE?',
		]);
		await assertReadOnly(harness.client, 'get_display');
	});

	it('keeps an unrecognized interpolation answer as raw text', async () => {
		harness.fake.replies.set(':DISPlay:TYPE?', 'POINTS');
		try {
			const state = payload(await call(harness, 'get_display'));
			expect(state.join_points).toBeEqual({ raw: 'POINTS' });
		} finally {
			harness.fake.replies.set(':DISPlay:TYPE?', 'VECTor');
			harness.fake.sent();
		}
	});

	it('writes dots as DOT and reads back only what it set', async () => {
		harness.fake.replies.set(':DISPlay:GRIDstyle?', 'NONE');
		harness.fake.replies.set(':DISPlay:PERSistence?', 'OFF');
		harness.fake.replies.set(':DISPlay:TYPE?', 'DOT');
		try {
			const result = payload(
				await call(harness, 'configure_display', { grid: 'NONE', persistence: 'OFF', join_points: false }),
			);
			expect(result.commands).toBeEqual([':DISPlay:GRIDstyle NONE', ':DISPlay:PERSistence OFF', ':DISPlay:TYPE DOT']);
			expect(result.state).toBeEqual({ grid: 'NONE', persistence: 'OFF', join_points: false });
			expect(result.warnings).toBe(undefined);
			assertSent(harness.fake, [
				':DISPlay:GRIDstyle NONE',
				':DISPlay:PERSistence OFF',
				':DISPlay:TYPE DOT',
				':DISPlay:GRIDstyle?',
				':DISPlay:PERSistence?',
				':DISPlay:TYPE?',
			]);
		} finally {
			harness.fake.replies.set(':DISPlay:GRIDstyle?', 'LIGHt');
			harness.fake.replies.set(':DISPlay:PERSistence?', '5S');
			harness.fake.replies.set(':DISPlay:TYPE?', 'VECTor');
		}
	});

	it('warns when the scope kept its own persistence', async () => {
		const result = payload(await call(harness, 'configure_display', { persistence: '100MS' }));
		expect((result.warnings as string[]).some((warning) => warning.includes('persistence'))).toBeTruthy();
		harness.fake.sent();
	});

	it('refuses the transparence on a bench scope before anything is sent', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_display', { transparence: 80, backlight: 50 });
		assertCapabilityError(result, 'SDS804X HD');
		assertSent(harness.fake, []);
	});

	it('clears the display and says so', async () => {
		const result = payload(await call(harness, 'clear_display'));
		expect(result.commands).toBeEqual([':DISPlay:CLEar']);
		assertSent(harness.fake, [':DISPlay:CLEar']);
		const { tools } = await harness.client.listTools();
		expect(tools.find(({ name }) => name === 'clear_display')?.annotations?.destructiveHint).toBe(true);
	});

	it('sends nothing for a display setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_display', {});
		await assertInvalidSendsNothing(harness, 'configure_display', { backlight: 101 });
		await assertInvalidSendsNothing(harness, 'configure_display', { grid_intensity: -1 });
		await assertInvalidSendsNothing(harness, 'configure_display', { persistence: '2S' });
		await assertInvalidSendsNothing(harness, 'configure_display', { grid: 'HALF' });
		await assertInvalidSendsNothing(harness, 'configure_display', { menu_hide: '1S' });
		await assertInvalidSendsNothing(harness, 'configure_display', { gridstyle: 'FULL' });
	});
});

describe('EN11F display tools on a handheld', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SHS1102X', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the transparence between persistence and interpolation', async () => {
		const state = payload(await call(harness, 'get_display'));
		expect(state.transparence).toBe(80);
		assertSent(harness.fake, [
			':DISPlay:AXIS?',
			':DISPlay:AXIS:MODE?',
			':DISPlay:BACKlight?',
			':DISPlay:COLor?',
			':DISPlay:GRATicule?',
			':DISPlay:GRIDstyle?',
			':DISPlay:INTensity?',
			':DISPlay:MENU?',
			':DISPlay:MENU:HIDE?',
			':DISPlay:PERSistence?',
			':DISPlay:TRANsparence?',
			':DISPlay:TYPE?',
		]);
	});

	it('writes the transparence and reads it back', async () => {
		const result = payload(await call(harness, 'configure_display', { transparence: 80 }));
		expect(result.commands).toBeEqual([':DISPlay:TRANsparence 80']);
		expect(result.state).toBeEqual({ transparence: 80 });
		assertSent(harness.fake, [':DISPlay:TRANsparence 80', ':DISPlay:TRANsparence?']);
	});
});
