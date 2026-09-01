import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	assertUnknownWarning,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const lines = Array.from({ length: 16 }, (_, index) => `D${index}`);
const traces = (mnemonic: string) =>
	Object.fromEntries(lines.map((line, index) => [`${line}:${mnemonic}?`, index % 2 === 0 ? 'ON' : 'OFF']));

const xeReplies = {
	'DI:SW?': 'ON',
	...traces('TRA'),
	'L8:TSM?': 'CUSTOM',
	'L8:CUS?': '5.00E+00V',
	'H8:TSM?': 'LVCMOS33',
};

const plusReplies = {
	'DGST?': 'ON',
	...traces('DGCH'),
	'C1:DGTH?': 'CMOS3.3',
	'C2:DGTH?': 'CUSTOM,3.00E+00V',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

async function connect(replies: Record<string, string>, model?: string): Promise<Harness> {
	const harness = await startHarness(
		model ? { ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` } : replies,
	);
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('digital tools on SDS1000X-E', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(xeReplies);
	});

	after(() => harness.close());

	it('reads the state, every line and both group thresholds', async () => {
		const result = await call(harness, 'get_digital');
		const state = payload(result);
		expect(state.variant).toBe('xe');
		expect(state.option).toBeEqual({ feature: 'mso_xe', support: 'unknown' });
		expect(state.enabled).toBeEqual({ enabled: true, raw: 'ON' });
		expect(state.lines).toBeEqual(
			Object.fromEntries(
				lines.map((line, index) => [line, { enabled: index % 2 === 0, raw: index % 2 === 0 ? 'ON' : 'OFF' }]),
			),
		);
		expect(state.thresholds).toBeEqual([
			{
				group: 'd0_d7',
				name: 'L8',
				mode: 'CUSTOM',
				custom: { value: 5, unit: 'V', raw: '5.00E+00V' },
				raw: 'CUSTOM',
			},
			{ group: 'd8_d15', name: 'H8', mode: 'LVCMOS33', raw: 'LVCMOS33' },
		]);
		assertSent(harness.fake, ['DI:SW?', ...lines.map((line) => `${line}:TRA?`), 'L8:TSM?', 'L8:CUS?', 'H8:TSM?']);
		assertUnknownWarning(result, 'mso_xe');
		await assertReadOnly(harness.client, 'get_digital');
	});

	it('reads fewer lines on request', async () => {
		payload(await call(harness, 'get_digital', { lines: ['D8'] }));
		assertSent(harness.fake, ['DI:SW?', 'D8:TRA?', 'L8:TSM?', 'L8:CUS?', 'H8:TSM?']);
	});

	it('enables digital, sets lines and group thresholds, then reads them back', async () => {
		const result = await call(harness, 'configure_digital', {
			enabled: true,
			lines: { D0: true, D8: false },
			thresholds: { d0_d7: { mode: 'LVCMOS33' }, d8_d15: { mode: 'CUSTOM', custom: '3V' } },
		});
		const commands = ['DI:SW ON', 'D0:TRA ON', 'D8:TRA OFF', 'L8:TSM LVCMOS33', 'H8:TSM CUSTOM', 'H8:CUS 3V'];
		const applied = payload(result);
		expect(applied.commands).toBeEqual(commands);
		expect(applied.state).toBeEqual({
			enabled: { enabled: true, raw: 'ON' },
			lines: { D0: { enabled: true, raw: 'ON' }, D8: { enabled: true, raw: 'ON' } },
			thresholds: [
				{
					group: 'd0_d7',
					name: 'L8',
					mode: 'CUSTOM',
					custom: { value: 5, unit: 'V', raw: '5.00E+00V' },
					raw: 'CUSTOM',
				},
				{ group: 'd8_d15', name: 'H8', mode: 'LVCMOS33', raw: 'LVCMOS33' },
			],
		});
		assertSent(harness.fake, [...commands, 'DI:SW?', 'D0:TRA?', 'D8:TRA?', 'L8:TSM?', 'L8:CUS?', 'H8:TSM?']);
		expect(
			(applied.warnings as string[]).some((warning) => /custom threshold range varies by model/.test(warning)),
		).toBeTruthy();
	});

	it('never touches the analog trace command for a digital line', async () => {
		const applied = payload(await call(harness, 'configure_digital', { lines: { D15: true } }));
		expect(applied.commands).toBeEqual(['D15:TRA ON']);
		expect(harness.fake.sent()).toBeEqual(['D15:TRA ON', 'D15:TRA?']);
	});

	it('rejects the SDS2000X/SDS1000X threshold spelling', async () => {
		const result = await call(harness, 'configure_digital', { thresholds: { d0_d7: { mode: 'CMOS3.3' } } });
		const error = assertCapabilityError(result, 'SDS1104X-E');
		expect(error.error).toMatchRegex(/Use LVCMOS33 instead of CMOS3.3/);
		assertSent(harness.fake, []);
	});

	it('sends nothing for an empty or malformed request', async () => {
		await assertInvalidSendsNothing(harness, 'configure_digital', {});
		await assertInvalidSendsNothing(harness, 'configure_digital', { lines: {} });
		await assertInvalidSendsNothing(harness, 'configure_digital', { lines: { D16: true } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { lines: { D0: 'ON' } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { enabled: 'ON' });
		await assertInvalidSendsNothing(harness, 'configure_digital', { thresholds: {} });
		await assertInvalidSendsNothing(harness, 'configure_digital', { thresholds: { d0_d7: {} } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { thresholds: { d0_d15: { mode: 'TTL' } } });
		await assertInvalidSendsNothing(harness, 'configure_digital', { thresholds: { d0_d7: { mode: 'CMOS3.0' } } });
		await assertInvalidSendsNothing(harness, 'configure_digital', {
			thresholds: { d0_d7: { mode: 'TTL', custom: '1V' } },
		});
		await assertInvalidSendsNothing(harness, 'configure_digital', {
			thresholds: { d0_d7: { mode: 'CUSTOM', custom: '1XV' } },
		});
		await assertInvalidSendsNothing(harness, 'get_digital', { lines: ['D16'] });
	});

	it('accepts a unitless custom level as volts, per the guide', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_digital', { thresholds: { d8_d15: { mode: 'CUSTOM', custom: '1.5' } } }),
		);
		expect(result.commands).toBeEqual(['H8:TSM CUSTOM', 'H8:CUS 1.5']);
	});
});

describe('digital tools on SDS1000X/SDS2000X', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(plusReplies, 'SDS1104X');
	});

	after(() => harness.close());

	it('reads the state with the DGST, DGCH and DGTH commands', async () => {
		const result = await call(harness, 'get_digital', { lines: ['D8'] });
		const state = payload(result);
		expect(state.variant).toBe('plus');
		expect(state.option).toBeEqual({ feature: 'mso', support: 'unknown' });
		expect(state.thresholds).toBeEqual([
			{ group: 'd0_d7', name: 'C1', mode: 'CMOS3.3', raw: 'CMOS3.3' },
			{
				group: 'd8_d15',
				name: 'C2',
				mode: 'CUSTOM',
				custom: { value: 3, unit: 'V', raw: '3.00E+00V' },
				raw: 'CUSTOM,3.00E+00V',
			},
		]);
		assertSent(harness.fake, ['DGST?', 'D8:DGCH?', 'C1:DGTH?', 'C2:DGTH?']);
		assertUnknownWarning(result, 'mso');
	});

	it('sends the guide examples and keeps the custom level in one DGTH command', async () => {
		const applied = payload(
			await call(harness, 'configure_digital', {
				enabled: true,
				lines: { D8: true },
				thresholds: { d0_d7: { mode: 'CMOS3.3' }, d8_d15: { mode: 'CUSTOM', custom: '3V' } },
			}),
		);
		const commands = ['DGST ON', 'D8:DGCH ON', 'C1:DGTH CMOS3.3', 'C2:DGTH CUSTOM,3V'];
		expect(applied.commands).toBeEqual(commands);
		assertSent(harness.fake, [...commands, 'DGST?', 'D8:DGCH?', 'C1:DGTH?', 'C2:DGTH?']);
	});

	it('rejects the SDS1000X-E threshold spelling', async () => {
		const result = await call(harness, 'configure_digital', { thresholds: { d8_d15: { mode: 'LVCMOS25' } } });
		expect(assertCapabilityError(result, 'SDS1104X').error).toMatchRegex(/Use CMOS2.5 instead of LVCMOS25/);
		assertSent(harness.fake, []);
	});

	it('keeps the custom level inside the documented -5 V to 5 V range', async () => {
		const applied = payload(
			await call(harness, 'configure_digital', { thresholds: { d0_d7: { mode: 'CUSTOM', custom: '5000MV' } } }),
		);
		expect(applied.commands).toBeEqual(['C1:DGTH CUSTOM,5000MV']);
		harness.fake.sent();
		for (const custom of ['5001MV', '6V', '-5.5V']) {
			const result = await call(harness, 'configure_digital', { thresholds: { d0_d7: { mode: 'CUSTOM', custom } } });
			expect(assertCapabilityError(result, 'SDS1104X').error).toMatchRegex(/-5V to 5V/);
		}
		assertSent(harness.fake, []);
	});

	it("reports the guide's ambiguous DGTH response format instead of guessing a mode", async () => {
		harness.fake.replies.set('C1:DGTH?', 'C1,3.00E+00V');
		try {
			const state = payload(await call(harness, 'get_digital', { lines: [] }));
			expect(state.thresholds).toBeEqual([
				{
					group: 'd0_d7',
					name: 'C1',
					custom: { value: 3, unit: 'V', raw: '3.00E+00V' },
					raw: 'C1,3.00E+00V',
				},
				{
					group: 'd8_d15',
					name: 'C2',
					mode: 'CUSTOM',
					custom: { value: 3, unit: 'V', raw: '3.00E+00V' },
					raw: 'CUSTOM,3.00E+00V',
				},
			]);
			expect(
				(state.warnings as string[]).some((warning) => /threshold response.*was not recognized/.test(warning)),
			).toBeTruthy();
			assertSent(harness.fake, ['DGST?', 'C1:DGTH?', 'C2:DGTH?']);
		} finally {
			harness.fake.replies.set('C1:DGTH?', 'CMOS3.3');
		}
	});
});

describe('digital support', () => {
	it('sends nothing to a family the guide lists without the digital subsystem', async () => {
		const older = await connect({}, 'SDS1102CML+');
		try {
			assertCapabilityError(await call(older, 'get_digital', { lines: ['D0'] }), 'SDS1102CML\\+');
			assertCapabilityError(await call(older, 'configure_digital', { enabled: true }), 'SDS1102CML\\+');
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('sends nothing to a newer-dialect model', async () => {
		const newer = await connect({}, 'SDS2504X Plus');
		try {
			assertCapabilityError(await call(newer, 'get_digital', { lines: ['D0'] }), 'SDS2504X Plus');
			assertCapabilityError(await call(newer, 'configure_digital', { lines: { D0: true } }), 'SDS2504X Plus');
			assertSent(newer.fake, []);
		} finally {
			await newer.close();
		}
	});

	it('warns which command set an unrecognized model gets and never claims the MSO option', async () => {
		const unknown = await connect(plusReplies, 'SDS9999Z');
		try {
			const result = await call(unknown, 'get_digital', { lines: ['D0'] });
			const state = payload(result);
			expect(state.option).toBeEqual({ feature: 'mso', support: 'unknown' });
			assertUnknownWarning(result, 'mso');
			expect(
				(state.warnings as string[]).some((warning) =>
					/unknown digital support.*SDS2000X\/SDS1000X command set/.test(warning),
				),
			).toBeTruthy();
			assertSent(unknown.fake, ['DGST?', 'D0:DGCH?', 'C1:DGTH?', 'C2:DGTH?']);
		} finally {
			await unknown.close();
		}
	});
});
