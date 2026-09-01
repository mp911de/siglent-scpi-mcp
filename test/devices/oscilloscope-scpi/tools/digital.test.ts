import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':DIGital?': 'ON',
	':DIGital:ACTive?': 'D5',
	':DIGital:HEIGht?': '6.00E+00',
	':DIGital:POSition?': '4.00E+00',
	':DIGital:SKEW?': '1.00E-07',
	':DIGital:SRATe?': '1.25E+09',
	':DIGital:POINts?': '6.25E+02',
	':DIGital:THReshold1?': 'CMOS',
	':DIGital:THReshold2?': 'CUSTom,1.50E+00',
	':DIGital:BUS1:DISPlay?': 'ON',
	':DIGital:BUS1:FORMat?': 'HEX',
	':DIGital:BUS1:MAP?': 'D0,D3,D7,D15',
	':DIGital:BUS2:DISPlay?': 'OFF',
	':DIGital:BUS2:FORMat?': 'BINary',
	':DIGital:BUS2:MAP?': 'D0,D1,D2,D3',
};
for (let line = 0; line < 16; line++) {
	replies[`:DIGital:D${line}?`] = line === 5 ? 'ON' : 'OFF';
	replies[`:DIGital:LABel${line}?`] = `"D${line}"`;
}

const msoWarning = (warnings: unknown): boolean =>
	Array.isArray(warnings) && warnings.some((warning) => String(warning).includes('MSO option'));

describe('EN11F digital tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads one line with its label, thresholds and both buses', async () => {
		const { warnings, ...state } = payload(await call(harness, 'get_digital', { lines: ['D5'] }));
		expect(state).toBeEqual({
			enabled: true,
			active: 'D5',
			height: { value: 6, raw: '6.00E+00' },
			position: { value: 4, raw: '4.00E+00' },
			skew: { value: 1e-7, raw: '1.00E-07' },
			sample_rate: { value: 1.25e9, raw: '1.25E+09' },
			points: { value: 625, raw: '6.25E+02' },
			lines: { D5: true },
			labels: { D5: 'D5' },
			thresholds: {
				d0_d7: { mode: 'CMOS', raw: 'CMOS' },
				d8_d15: { mode: 'CUSTom', custom: { value: 1.5, raw: '1.50E+00' }, raw: 'CUSTom,1.50E+00' },
			},
			buses: {
				bus1: { display: true, format: 'HEX', map: ['D0', 'D3', 'D7', 'D15'] },
				bus2: { display: false, format: 'BINary', map: ['D0', 'D1', 'D2', 'D3'] },
			},
		});
		expect(msoWarning(warnings)).toBeTruthy();
		assertSent(harness.fake, [
			':DIGital?',
			':DIGital:ACTive?',
			':DIGital:HEIGht?',
			':DIGital:POSition?',
			':DIGital:SKEW?',
			':DIGital:SRATe?',
			':DIGital:POINts?',
			':DIGital:D5?',
			':DIGital:LABel5?',
			':DIGital:THReshold1?',
			':DIGital:THReshold2?',
			':DIGital:BUS1:DISPlay?',
			':DIGital:BUS1:FORMat?',
			':DIGital:BUS1:MAP?',
			':DIGital:BUS2:DISPlay?',
			':DIGital:BUS2:FORMat?',
			':DIGital:BUS2:MAP?',
		]);
		await assertReadOnly(harness.client, 'get_digital');
	});

	it('reads all sixteen lines by default', async () => {
		const state = payload(await call(harness, 'get_digital'));
		expect(Object.keys(state.lines as Record<string, boolean>).length).toBe(16);
		expect(Object.keys(state.labels as Record<string, string>).length).toBe(16);
		harness.fake.sent();
	});

	it('skips the sample rate and points while the digital function is off', async () => {
		harness.fake.replies.set(':DIGital?', 'OFF');
		try {
			const state = payload(await call(harness, 'get_digital', { lines: ['D0'] }));
			expect(state.enabled).toBe(false);
			expect(state.sample_rate).toBe(undefined);
			expect(state.points).toBe(undefined);
			expect((state.warnings as string[]).some((warning) => warning.includes('sample rate'))).toBeTruthy();
			const sent = harness.fake.sent();
			expect(!sent.includes(':DIGital:SRATe?') && !sent.includes(':DIGital:POINts?')).toBeTruthy();
		} finally {
			harness.fake.replies.set(':DIGital?', 'ON');
		}
	});

	it('writes the whole digital setup in one transaction and reads back what it set', async () => {
		const result = payload(
			await call(harness, 'configure_digital', {
				enabled: true,
				active: 'D5',
				lines: { D5: true },
				labels: { D5: 'D5' },
				height: 6,
				position: 4,
				skew: 1e-7,
				thresholds: { d0_d7: { mode: 'CMOS' }, d8_d15: { mode: 'CUSTom', custom: 1.5 } },
				buses: { bus1: { display: true, format: 'HEX', map: ['D0', 'D3', 'D7', 'D15'] }, bus2: { default_map: true } },
			}),
		);
		expect(result.commands).toBeEqual([
			':DIGital ON',
			':DIGital:ACTive D5',
			':DIGital:D5 ON',
			':DIGital:LABel5 "D5"',
			':DIGital:HEIGht 6.00E+00',
			':DIGital:POSition 4.00E+00',
			':DIGital:SKEW 1.00E-07',
			':DIGital:THReshold1 CMOS',
			':DIGital:THReshold2 CUSTom,1.50E+00',
			':DIGital:BUS1:DISPlay ON',
			':DIGital:BUS1:FORMat HEX',
			':DIGital:BUS1:MAP D0,D3,D7,D15',
			':DIGital:BUS2:DEFault',
		]);
		expect((result.state as Record<string, unknown>).buses).toBeEqual({
			bus1: { display: true, format: 'HEX', map: ['D0', 'D3', 'D7', 'D15'] },
			bus2: { map: ['D0', 'D1', 'D2', 'D3'] },
		});
		expect(msoWarning(result.warnings)).toBeTruthy();
		assertSent(harness.fake, [
			':DIGital ON',
			':DIGital:ACTive D5',
			':DIGital:D5 ON',
			':DIGital:LABel5 "D5"',
			':DIGital:HEIGht 6.00E+00',
			':DIGital:POSition 4.00E+00',
			':DIGital:SKEW 1.00E-07',
			':DIGital:THReshold1 CMOS',
			':DIGital:THReshold2 CUSTom,1.50E+00',
			':DIGital:BUS1:DISPlay ON',
			':DIGital:BUS1:FORMat HEX',
			':DIGital:BUS1:MAP D0,D3,D7,D15',
			':DIGital:BUS2:DEFault',
			':DIGital?',
			':DIGital:ACTive?',
			':DIGital:D5?',
			':DIGital:LABel5?',
			':DIGital:HEIGht?',
			':DIGital:POSition?',
			':DIGital:SKEW?',
			':DIGital:THReshold1?',
			':DIGital:THReshold2?',
			':DIGital:BUS1:DISPlay?',
			':DIGital:BUS1:FORMat?',
			':DIGital:BUS1:MAP?',
			':DIGital:BUS2:MAP?',
		]);
	});

	it('warns when a custom threshold exceeds the printed range of this model', async () => {
		const result = payload(
			await call(harness, 'configure_digital', { thresholds: { d8_d15: { mode: 'CUSTom', custom: 1.5 } } }),
		);
		expect(
			(result.warnings as string[]).some(
				(warning) => warning.includes('-0.8 V to 0.8 V') && warning.includes('d8_d15'),
			),
		).toBeTruthy();
		harness.fake.sent();
	});

	it('warns when the scope kept its own threshold', async () => {
		harness.fake.replies.set(':DIGital:THReshold1?', 'TTL');
		try {
			const result = payload(await call(harness, 'configure_digital', { thresholds: { d0_d7: { mode: 'CMOS' } } }));
			expect(
				(result.warnings as string[]).some((warning) => warning.includes('d0_d7') && warning.includes('TTL')),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set(':DIGital:THReshold1?', 'CMOS');
			harness.fake.sent();
		}
	});

	it('warns when the scope kept a line hidden', async () => {
		harness.fake.replies.set(':DIGital:D3?', 'OFF');
		const result = payload(await call(harness, 'configure_digital', { lines: { D3: true } }));
		expect((result.warnings as string[]).some((warning) => warning.includes('lines.D3'))).toBeTruthy();
		harness.fake.sent();
	});

	it('sends nothing for a digital setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_digital', {});
		await assertInvalidSendsNothing(harness, 'configure_digital', { lines: { D16: true } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { labels: { D5: 'TOO_LONG_LABEL' } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { height: 9 });
		await assertInvalidSendsNothing(harness, 'configure_digital', { skew: 2e-7 });
		await assertInvalidSendsNothing(harness, 'configure_digital', {
			thresholds: { d0_d7: { mode: 'TTL', custom: 1 } },
		});
		await assertInvalidSendsNothing(harness, 'configure_digital', {
			thresholds: { d0_d7: { mode: 'CUSTom', custom: 11 } },
		});
		await assertInvalidSendsNothing(harness, 'configure_digital', {
			buses: { bus1: { map: ['D0'], default_map: true } },
		});
		await assertInvalidSendsNothing(harness, 'configure_digital', { enabled: true, line: { D0: true } });
	});
});
