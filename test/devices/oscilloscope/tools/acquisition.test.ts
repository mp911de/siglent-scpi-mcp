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

const replies = {
	'SAST?': 'Stop',
	'SARA?': '1.00E+09Sa/s',
	'TDIV?': '1.00E-06S',
	'TRDL?': '0.00E+00S',
	'TRMD?': 'AUTO',
	'ACQW?': 'AVERAGE,16',
	'AVGA?': '16',
	'MSIZ?': '14M',
	'SXSA?': 'ON',
	'XYDS?': 'OFF',
	'SANU? C2': '7.00E+05pts',
	'DI:SARA?': '5.00E+08Sa/s',
};

const baseQueries = ['SAST?', 'SARA?', 'TDIV?', 'TRDL?', 'TRMD?', 'ACQW?', 'AVGA?', 'MSIZ?', 'SXSA?', 'XYDS?'];

async function withReplies<T>(harness: Harness, overrides: Record<string, string>, work: () => Promise<T>) {
	const previous = Object.keys(overrides).map((key) => [key, harness.fake.replies.get(key)] as const);
	for (const [key, value] of Object.entries(overrides)) harness.fake.replies.set(key, value);
	try {
		return await work();
	} finally {
		for (const [key, value] of previous) harness.fake.replies.set(key, value);
	}
}

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const configure = (harness: Harness, args: Record<string, unknown>) => call(harness, 'configure_acquisition', args);

describe('acquisition tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads status, mode, average count, memory depth, interpolation and XY display', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_acquisition'));
		expect(state.status).toBeEqual({ state: 'Stop', raw: 'Stop' });
		expect(state.sample_rate).toBeEqual({ value: 1e9, unit: 'Sa/s', raw: '1.00E+09Sa/s' });
		expect(state.acquisition_mode).toBeEqual({ mode: 'AVERAGE', average_count: 16, raw: 'AVERAGE,16' });
		expect(state.average_count).toBeEqual({ value: 16, raw: '16' });
		expect(state.memory_depth).toBeEqual({ size: '14M', raw: '14M' });
		expect(state.interpolation).toBeEqual({ mode: 'sine', raw: 'ON' });
		expect(state.xy_display).toBeEqual({ enabled: false, raw: 'OFF' });
		expect(state.warnings).toBe(undefined);
		expect('points' in state || 'digital_sample_rate' in state).toBe(false);
		assertSent(harness.fake, baseQueries);
		await assertReadOnly(harness.client, 'get_acquisition');
	});

	it('parses the newer status and sample rate formats and keeps malformed or empty replies raw', async () => {
		await withReplies(
			harness,
			{ 'SAST?': "SAST Trig'd", 'SARA?': '1.00 GSa/s', 'SXSA?': 'SXSA', 'XYDS?': '****' },
			async () => {
				const state = payload(await call(harness, 'get_acquisition'));
				expect(state.status).toBeEqual({ state: "Trig'd", raw: "SAST Trig'd" });
				expect(state.sample_rate).toBeEqual({ value: 1e9, unit: 'Sa/s', raw: '1.00 GSa/s' });
				expect(state.interpolation).toBeEqual({ raw: 'SXSA' });
				expect(state.xy_display).toBeEqual({ raw: '****' });
			},
		);
		await withReplies(harness, { 'SAST?': ' ' }, async () => {
			expect(payload(await call(harness, 'get_acquisition')).status).toBeEqual({ raw: '' });
		});
	});

	it('reads the point count of an analog channel after the base state', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_acquisition', { source: 'C2' }));
		expect(state.points).toBeEqual({ value: 7e5, unit: 'pts', raw: '7.00E+05pts' });
		assertSent(harness.fake, [...baseQueries, 'SANU? C2']);
		await withReplies(harness, { 'SANU? C2': '28Mpts' }, async () => {
			expect(payload(await call(harness, 'get_acquisition', { source: 'C2' })).points).toBeEqual({
				value: 28e6,
				unit: 'pts',
				raw: '28Mpts',
			});
		});
		await withReplies(harness, { 'SANU? C2': '1600' }, async () => {
			expect(payload(await call(harness, 'get_acquisition', { source: 'C2' })).points).toBeEqual({
				value: 1600,
				raw: '1600',
			});
		});
	});

	it('rejects an unknown source and a channel the model does not have before querying', async () => {
		await assertInvalidSendsNothing(harness, 'get_acquisition', { source: 'D0' });
		const two = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0002,7.6.1.20' });
		try {
			await call(two, 'identify');
			two.fake.sent();
			assertCapabilityError(await call(two, 'get_acquisition', { source: 'C3' }), 'SDS1202X-E');
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});

	it('reads the digital sample rate on SDS1000X-E with an unknown-option warning', async () => {
		harness.fake.sent();
		const result = await call(harness, 'get_acquisition', { source: 'digital' });
		assertUnknownWarning(result, 'mso_xe');
		expect(payload(result).digital_sample_rate).toBeEqual({ value: 5e8, unit: 'Sa/s', raw: '5.00E+08Sa/s' });
		assertSent(harness.fake, [...baseQueries, 'DI:SARA?']);
		await withReplies(harness, { 'DI:SARA?': 'DI:SARA' }, async () => {
			expect(payload(await call(harness, 'get_acquisition', { source: 'digital' })).digital_sample_rate).toBeEqual({
				raw: 'DI:SARA',
			});
		});
	});

	it('never sends DI:SARA? to a family the guide lists as invalid', async () => {
		const x = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS1104X,SDS1XAAA0L0001,1.0' });
		try {
			await call(x, 'identify');
			x.fake.sent();
			assertCapabilityError(await call(x, 'get_acquisition', { source: 'digital' }), 'SDS1104X');
			assertSent(x.fake, []);
		} finally {
			await x.close();
		}
	});

	it('configures interpolation and XY display in order and reads both back', async () => {
		await withReplies(harness, { 'SXSA?': 'OFF', 'XYDS?': 'ON' }, async () => {
			harness.fake.sent();
			const result = payload(
				await call(harness, 'configure_acquisition_display', { interpolation: 'linear', xy_display: true }),
			);
			expect(result.commands).toBeEqual(['SXSA OFF', 'XYDS ON']);
			expect(result.state).toBeEqual({
				interpolation: { mode: 'linear', raw: 'OFF' },
				xy_display: { enabled: true, raw: 'ON' },
			});
			assertSent(harness.fake, ['SXSA OFF', 'XYDS ON', 'SXSA?', 'XYDS?']);
		});
		harness.fake.sent();
		expect(payload(await call(harness, 'configure_acquisition_display', { xy_display: false })).commands).toBeEqual([
			'XYDS OFF',
		]);
		assertSent(harness.fake, ['XYDS OFF', 'XYDS?']);
		const { tools } = await harness.client.listTools();
		expect(tools.find((tool) => tool.name === 'configure_acquisition_display')?.annotations?.readOnlyHint).toBe(false);
	});

	it('rejects an unknown interpolation and an empty display request before writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_acquisition_display', { interpolation: 'cubic' });
		await assertInvalidSendsNothing(harness, 'configure_acquisition_display', {});
	});

	it('keeps raw for a mode without count and an unparseable depth', async () => {
		harness.fake.replies.set('ACQW?', 'SAMPLING');
		harness.fake.replies.set('MSIZ?', '****');
		try {
			const state = payload(await call(harness, 'get_acquisition'));
			expect(state.acquisition_mode).toBeEqual({ mode: 'SAMPLING', raw: 'SAMPLING' });
			expect(state.memory_depth).toBeEqual({ raw: '****' });
		} finally {
			harness.fake.replies.set('ACQW?', 'AVERAGE,16');
			harness.fake.replies.set('MSIZ?', '14M');
		}
	});

	it('sets AVERAGE with its count in one ACQW write and reads both back', async () => {
		harness.fake.sent();
		const result = payload(await configure(harness, { mode: 'AVERAGE', average_count: 16 }));
		expect(result.commands).toBeEqual(['ACQW AVERAGE,16']);
		expect(result.warnings).toBe(undefined);
		const state = result.state as { acquisition_mode: { mode?: string }; average_count: { value?: number } };
		expect(state.acquisition_mode.mode).toBe('AVERAGE');
		expect(state.average_count.value).toBe(16);
		expect(harness.fake.sent()).toBeEqual(['ACQW AVERAGE,16', 'ACQW?', 'AVGA?', 'MSIZ?']);
	});

	it('sets the average count alone with AVGA', async () => {
		harness.fake.replies.set('AVGA?', '64');
		harness.fake.sent();
		try {
			expect(payload(await configure(harness, { average_count: 64 })).commands).toBeEqual(['AVGA 64']);
			expect(harness.fake.sent()[0]).toBe('AVGA 64');
		} finally {
			harness.fake.replies.set('AVGA?', '16');
		}
	});

	it('rejects a count with a non-average mode, undocumented counts and depths before writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { mode: 'PEAK_DETECT', average_count: 16 });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { mode: 'AVERAGE', average_count: 10 });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { memory_depth: '28M' });
		await assertInvalidSendsNothing(harness, 'configure_acquisition', { mode: 'FAST' });
	});

	it('sends setup before run and reports the order', async () => {
		harness.fake.replies.set('ACQW?', 'SAMPLING');
		harness.fake.sent();
		try {
			const result = payload(
				await configure(harness, { time_per_div: '1US', mode: 'SAMPLING', memory_depth: '14M', action: 'run' }),
			);
			expect(result.commands).toBeEqual(['TDIV 1US', 'ACQW SAMPLING', 'MSIZ 14M', 'ARM']);
			expect(result.commands).toBeEqual(harness.fake.sent().slice(0, 4));
		} finally {
			harness.fake.replies.set('ACQW?', 'AVERAGE,16');
		}
	});

	it('fails instead of accepting a depth or count the scope adjusted', async () => {
		harness.fake.replies.set('MSIZ?', '7M');
		try {
			const result = await configure(harness, { memory_depth: '14M' });
			expect(result.isError).toBe(true);
			expect(payload(result).error as string).toMatchRegex(/did not apply memory depth 14M.*memory depth "7M"/);
			expect(payload(result).kind).toBe('scpi');
		} finally {
			harness.fake.replies.set('MSIZ?', '14M');
		}
		const result = await configure(harness, { mode: 'AVERAGE', average_count: 1024 });
		expect(result.isError).toBe(true);
		expect(payload(result).error as string).toMatchRegex(/did not apply average count 1024/);
	});

	it('accepts HIGH_RES on an SPO model without warnings', async () => {
		harness.fake.replies.set('ACQW?', 'HIGH_RES');
		try {
			const result = payload(await configure(harness, { mode: 'HIGH_RES' }));
			expect(result.commands).toBeEqual(['ACQW HIGH_RES']);
			expect(result.warnings).toBe(undefined);
		} finally {
			harness.fake.replies.set('ACQW?', 'AVERAGE,16');
		}
	});

	it('rejects HIGH_RES on a non-SPO model without writing', async () => {
		const nonSpo = await startHarness({
			...replies,
			'*IDN?': 'Siglent Technologies,SDS1102CML+,SDS1EBAC0L0002,5.1.0',
			'ACQW?': 'PEAK_DETECT',
		});
		try {
			await call(nonSpo, 'identify');
			nonSpo.fake.sent();
			assertCapabilityError(await configure(nonSpo, { mode: 'HIGH_RES' }), 'SDS1102CML\\+');
			assertSent(nonSpo.fake, []);
			expect(payload(await configure(nonSpo, { mode: 'PEAK_DETECT' })).commands).toBeEqual(['ACQW PEAK_DETECT']);
		} finally {
			await nonSpo.close();
		}
	});

	it('warns that HIGH_RES support is unknown on an unrecognized model', async () => {
		const unknown = await startHarness({
			...replies,
			'*IDN?': 'Siglent Technologies,SDS9999,SDS1EBAC0L0001,1.0',
			'ACQW?': 'HIGH_RES',
		});
		try {
			assertUnknownWarning(await configure(unknown, { mode: 'HIGH_RES' }), 'spo');
		} finally {
			await unknown.close();
		}
	});

	it('refuses the newer dialect without writing', async () => {
		const plus = await startHarness({ '*IDN?': 'Siglent Technologies,SDS2104X Plus,SDS2PA0000001,1.3.9' });
		try {
			await call(plus, 'identify');
			plus.fake.sent();
			assertCapabilityError(await configure(plus, { mode: 'SAMPLING', action: 'run' }), 'SDS2104X Plus');
			assertCapabilityError(await call(plus, 'configure_acquisition_display', { xy_display: true }), 'SDS2104X Plus');
			assertSent(plus.fake, []);
		} finally {
			await plus.close();
		}
	});
});
