import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':TIMebase:REFerence?': 'DELay',
	':TIMebase:REFerence:POSition?': '20',
	':TIMebase:SCALe?': '1.00E-07',
	':TIMebase:DELay?': '1.00E-05',
	':TIMebase:WINDow?': 'ON',
	':TIMebase:WINDow:SCALe?': '1.00E-08',
	':TIMebase:WINDow:DELay?': '1.00E-03',
};

describe('EN11F timebase tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('keeps a reference position the scope cannot number as raw text, with a warning', async () => {
		harness.fake.replies.set(':TIMebase:REFerence:POSition?', '****');
		try {
			const state = payload(await call(harness, 'get_timebase'));
			expect(state.reference_position).toBeEqual({ raw: '****' });
			expect((state.warnings as string[]).some((warning) => warning.includes('reference_position'))).toBeTruthy();
		} finally {
			harness.fake.replies.set(':TIMebase:REFerence:POSition?', '20');
			harness.fake.sent();
		}
	});

	it('reads the whole horizontal state', async () => {
		const state = payload(await call(harness, 'get_timebase'));
		expect(state).toBeEqual({
			reference: 'DELay',
			reference_position: 20,
			time_per_div: { value: 1e-7, raw: '1.00E-07' },
			trigger_delay: { value: 1e-5, raw: '1.00E-05' },
			zoom_window: true,
			zoom_scale: { value: 1e-8, raw: '1.00E-08' },
			zoom_position: { value: 1e-3, raw: '1.00E-03' },
		});
		assertSent(harness.fake, [
			':TIMebase:REFerence?',
			':TIMebase:REFerence:POSition?',
			':TIMebase:SCALe?',
			':TIMebase:DELay?',
			':TIMebase:WINDow?',
			':TIMebase:WINDow:SCALe?',
			':TIMebase:WINDow:DELay?',
		]);
		await assertReadOnly(harness.client, 'get_timebase');
	});

	it('sends seconds as NR3 and the main sweep before the window it bounds', async () => {
		const result = payload(
			await call(harness, 'configure_timebase', {
				reference: 'DELay',
				reference_position: 20,
				time_per_div: 1e-7,
				trigger_delay: 1e-5,
				zoom_window: true,
				zoom_scale: 1e-8,
				zoom_position: 1e-3,
			}),
		);
		expect(result.commands).toBeEqual([
			':TIMebase:REFerence DELay',
			':TIMebase:REFerence:POSition 20',
			':TIMebase:SCALe 1.00E-07',
			':TIMebase:DELay 1.00E-05',
			':TIMebase:WINDow ON',
			':TIMebase:WINDow:SCALe 1.00E-08',
			':TIMebase:WINDow:DELay 1.00E-03',
		]);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':TIMebase:REFerence DELay',
			':TIMebase:REFerence:POSition 20',
			':TIMebase:SCALe 1.00E-07',
			':TIMebase:DELay 1.00E-05',
			':TIMebase:WINDow ON',
			':TIMebase:WINDow:SCALe 1.00E-08',
			':TIMebase:WINDow:DELay 1.00E-03',
			':TIMebase:REFerence?',
			':TIMebase:REFerence:POSition?',
			':TIMebase:SCALe?',
			':TIMebase:DELay?',
			':TIMebase:WINDow?',
			':TIMebase:WINDow:SCALe?',
			':TIMebase:WINDow:DELay?',
		]);
	});

	it('reads back only what it set and sends a negative delay as NR3', async () => {
		harness.fake.replies.set(':TIMebase:DELay?', '-4.80E-06');
		const result = payload(await call(harness, 'configure_timebase', { trigger_delay: -4.8e-6 }));
		expect(result.commands).toBeEqual([':TIMebase:DELay -4.80E-06']);
		expect(result.state).toBeEqual({ trigger_delay: { value: -4.8e-6, raw: '-4.80E-06' } });
		assertSent(harness.fake, [':TIMebase:DELay -4.80E-06', ':TIMebase:DELay?']);
		harness.fake.replies.set(':TIMebase:DELay?', '1.00E-05');
	});

	it('warns when the scope kept the zoomed window inside the main sweep', async () => {
		const result = payload(await call(harness, 'configure_timebase', { zoom_scale: 1e-6 }));
		expect(
			(result.warnings as string[]).some(
				(warning) => warning.includes('zoom_scale') && warning.includes('inside the main sweep'),
			),
		).toBeTruthy();
		harness.fake.sent();
	});

	it('sends nothing for a horizontal setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_timebase', {});
		await assertInvalidSendsNothing(harness, 'configure_timebase', { reference: 'DELay', reference_pos: 20 });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { reference: 'CENTre' });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { reference_position: 101 });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { time_per_div: 0 });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { zoom_scale: '1US' });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { trigger_delay: -100_000 });
	});
});
