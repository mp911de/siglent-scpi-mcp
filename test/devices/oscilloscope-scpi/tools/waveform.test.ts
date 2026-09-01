import type { Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertCapabilityError, assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';
import { block, codes, type Descriptor, example12, wavedesc } from '../../../support/wavedesc.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const close = (actual: unknown, expected: number, _what: string) =>
	expect(typeof actual === 'number' && Math.abs(actual - expected) <= Math.abs(expected) * 1e-9).toBeTruthy();

const setup = ':WAVeform:SOURce C1,:WAVeform:INTerval 1,:WAVeform:STARt 0,:WAVeform:PREamble?'.split(',');
const RELEASE = ':SYSTem:REMote OFF';
const plan = [':TIMebase:SCALe?', ':ACQuire:POINts?', ':WAVeform:MAXPoint?'];

interface Waveform {
	time: number[];
	voltage?: number[];
	code?: number[];
	decimation: number;
}

const waveformOf = (result: Record<string, unknown>): Waveform => result.waveform as Waveform;

describe('EN11F waveform transfer', () => {
	let harness: ScpiHarness;

	const stage = (descriptor: Partial<Descriptor> | Array<Partial<Descriptor>>, ...pieces: Buffer[]) => {
		const descriptors = Array.isArray(descriptor) ? [...descriptor] : [descriptor];
		harness.fake.replies.set(':WAVeform:PREamble?', (socket: Socket) =>
			socket.write(block(wavedesc(descriptors.length > 1 ? descriptors.shift() : descriptors[0]))),
		);
		const queue = [...pieces];
		harness.fake.replies.set(':WAVeform:DATA?', (socket: Socket) =>
			socket.write(block(queue.shift() ?? Buffer.alloc(0))),
		);
	};

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', {
			':TIMebase:SCALe?': '2.00E-08',
			':ACQuire:POINts?': '1000',
			':WAVeform:MAXPoint?': '10000000',
			':WAVeform:SEQuence?': '0,2',
		});
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('parses the descriptor the guide documents byte for byte', async () => {
		stage({}, codes([-11]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 1 }));
		expect(result.preamble).toBeEqual({
			template: 'WAVEACE',
			instrument: 'Siglent SDS',
			width: 'BYTE',
			byte_order: 'LSB',
			descriptor_bytes: 346,
			transferred_bytes: 1000,
			points: 1000,
			first_point: 0,
			data_interval: 1,
			read_frames: 1,
			sum_frames: 1,
			vertical_gain: 10,
			vertical_offset: 14.5,
			code_per_div: 30,
			adc_bits: 8,
			frame_index: 1,
			horizontal_interval: Math.fround(2e-10),
			horizontal_offset: 1.72e-8,
			timebase_index: 6,
			time_per_div: 2e-8,
			coupling: 'DC',
			probe_attenuation: 1,
			bandwidth_limit: 'OFF',
			wave_source: 'C1',
		});
		assertSent(harness.fake, [...setup, ...plan, ':WAVeform:POINt 1', ':WAVeform:DATA?', RELEASE]);
	});

	// The worked example of pp. 694-695: the first point is code -11 at 10 V/div, 14.5 V of offset and 30 codes per
	// division, which the guide converts to -18.167 V at -82.8 ns.
	it('converts a sample with the scale factors of the descriptor alone', async () => {
		stage({}, codes([-11, 0, 30]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3 }));
		const { time, voltage } = waveformOf(result);
		close(voltage?.[0], -18.166666666666664, 'first voltage');
		close(voltage?.[1], -14.5, 'second voltage');
		close(voltage?.[2], -4.5, 'third voltage');
		close(time[0], -8.28e-8, 'first time');
		close(time[1], -8.26e-8, 'second time');
		expect(result.scaling).toBeEqual({
			volts_per_division: 10,
			offset: 14.5,
			code_per_div: 30,
			probe_attenuation: 1,
			sample_bits: 8,
			adc_resolution_bits: 12,
			converted: true,
		});
		expect(result.summary).toBeEqual({
			count: 3,
			min: -18.1666666667,
			max: -4.5,
			mean: -12.3888888889,
			min_code: -11,
			max_code: 30,
		});
	});

	// The same signal on a 12-bit scope: word samples and a code_per_div counted in the same word, so the volts that
	// come out are the ones the 8-bit scope gives, from the same arithmetic.
	it('gets the same volts out of a 12-bit scope, in WORD format', async () => {
		stage({}, codes([-11, 0, 30]));
		const eight = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3 }));
		harness.fake.sent();
		stage([{ ...example12, width: 'BYTE' }, example12], codes([-11 * 256, 0, 30 * 256], 'WORD'));
		const twelve = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3 }));
		expect(waveformOf(twelve).voltage).toBeEqual(waveformOf(eight).voltage);
		expect(waveformOf(twelve).time).toBeEqual(waveformOf(eight).time);
		expect(twelve.summary).toBeEqual(eight.summary && { ...eight.summary, min_code: -2816, max_code: 7680 });
		expect((twelve.transfer as { width: string }).width).toBe('WORD');
		assertSent(harness.fake, [
			...setup,
			':WAVeform:WIDTh WORD',
			':WAVeform:PREamble?',
			...plan,
			':WAVeform:POINt 3',
			':WAVeform:DATA?',
			RELEASE,
		]);
	});

	it('decodes as BYTE and warns when the scope refuses the WORD width', async () => {
		stage(
			[
				{ ...example12, width: 'BYTE' },
				{ ...example12, width: 'BYTE' },
			],
			codes([-11, 0, 30]),
		);
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3 }));
		expect((result.transfer as { width: string }).width).toBe('BYTE');
		expect((result.summary as { min_code: number }).min_code).toBeEqual(-11);
		expect((result.summary as { max_code: number }).max_code).toBeEqual(30);
		expect((result.warnings as string[]).some((warning) => warning.includes('decoded as BYTE'))).toBeTruthy();
		assertSent(harness.fake, [
			...setup,
			':WAVeform:WIDTh WORD',
			':WAVeform:PREamble?',
			...plan,
			':WAVeform:POINt 3',
			':WAVeform:DATA?',
			RELEASE,
		]);
	});

	it('decodes as WORD and warns when the scope refuses the BYTE width', async () => {
		stage([{ width: 'WORD' }, { width: 'WORD' }], codes([-11, 0, 30], 'WORD'));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3 }));
		expect((result.transfer as { width: string }).width).toBe('WORD');
		expect((result.summary as { count: number }).count).toBeEqual(3);
		expect((result.summary as { min_code: number }).min_code).toBeEqual(-11);
		expect((result.summary as { max_code: number }).max_code).toBeEqual(30);
		expect((result.warnings as string[]).some((warning) => warning.includes('decoded as WORD'))).toBeTruthy();
		assertSent(harness.fake, [
			...setup,
			':WAVeform:WIDTh BYTE',
			':WAVeform:PREamble?',
			...plan,
			':WAVeform:POINt 3',
			':WAVeform:DATA?',
			RELEASE,
		]);
	});

	it('reads deep memory in pieces bounded by the maximum points of one piece', async () => {
		harness.fake.replies.set(':WAVeform:MAXPoint?', '4');
		stage({}, codes([0, 1, 2, 3]), codes([4, 5, 6, 7]), codes([8, 9]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 10 }));
		expect(waveformOf(result).code).toBeEqual(undefined);
		expect(waveformOf(result).voltage?.map((volts) => Math.round((volts + 14.5) * 3))).toBeEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
		expect(result.transfer).toBeEqual({
			requested: { first_point: 0, points: 10, interval: 1 },
			first_point: 0,
			interval: 1,
			width: 'BYTE',
			points: 10,
			bytes: 10,
			pieces: 3,
			max_points_per_piece: 4,
			acquired_points: 1000,
		});
		assertSent(harness.fake, [
			...setup,
			...plan,
			':WAVeform:POINt 4',
			':WAVeform:DATA?',
			':WAVeform:STARt 4',
			':WAVeform:POINt 4',
			':WAVeform:DATA?',
			':WAVeform:STARt 8',
			':WAVeform:POINt 2',
			':WAVeform:DATA?',
			RELEASE,
		]);
		harness.fake.replies.set(':WAVeform:MAXPoint?', '10000000');
	});

	it('summarizes every sample in one pass and decimates the series it returns', async () => {
		const record = Array.from({ length: 10_000 }, (_, index) => (index % 100) - 50);
		stage({}, codes(record));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 10_000 }));
		const { time, voltage, decimation } = waveformOf(result);
		expect(decimation).toBe(3);
		expect(voltage?.length).toBe(3334);
		expect(time.length).toBe(3334);
		expect(result.summary).toBeEqual({
			count: 10_000,
			min: -31.1666666667,
			max: 1.83333333333,
			mean: -14.6666666667,
			min_code: -50,
			max_code: 49,
		});
		const [first = 0, second = 0] = time;
		close(second - first, 3 * Math.fround(2e-10), 'decimated spacing');
		harness.fake.sent();
	});

	it('returns the statistics alone, or the whole series as a csv resource', async () => {
		stage({}, codes([-11, 0, 30]));
		const summary = payload(await call(harness, 'get_waveform', { source: 'C1', points: 3, output: 'summary' }));
		expect(summary.waveform).toBe(undefined);
		expect((summary.summary as { count: number }).count).toBe(3);
		stage({}, codes([-11, 0, 30]));
		const result = await call(harness, 'get_waveform', { source: 'C1', points: 3, output: 'csv' });
		const [, resource] = result.content as Array<{ resource?: { mimeType: string; text: string; uri: string } }>;
		expect(resource?.resource?.mimeType).toBe('text/csv');
		expect(resource?.resource?.uri).toBe('siglent://waveform/C1');
		expect(resource?.resource?.text.split('\n').length).toBe(4);
		expect(resource?.resource?.text ?? '').toMatchRegex(/^time,voltage\n/);
		harness.fake.sent();
	});

	it('warns when the codes cannot be counted in the divisions the descriptor gives', async () => {
		stage({ ...example12, code_per_div: 30 }, codes([-2816, 0], 'WORD'));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 2 }));
		expect(String(result.warnings)).toMatchRegex(/divisions/);
		harness.fake.sent();
	});

	it('warns when the record holds more than the transfer asks for', async () => {
		stage({}, codes([1, 2]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 2 }));
		expect(String(result.warnings)).toMatchRegex(/1000 points and 2 are transferred/);
		harness.fake.sent();
	});

	it('reads one slice of a sequence and reports the frames the descriptor counts', async () => {
		stage({ read_frames: 2, sum_frames: 5, frame_index: 0 }, codes([1, 2]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 2, frame: 0, frame_start: 2 }));
		const frames = result.frames as Record<string, unknown>;
		expect(frames.index).toBe(0);
		expect(frames.read).toBe(2);
		expect(frames.acquired).toBe(5);
		expect(String(frames.note)).toMatchRegex(/populates inconsistently/);
		expect((result.transfer as { sequence: string }).sequence).toBe('0,2');
		expect(String(result.warnings)).toMatchRegex(/5 sequence frames/);
		assertSent(harness.fake, [
			':WAVeform:SOURce C1',
			':WAVeform:SEQuence 0,2',
			':WAVeform:INTerval 1',
			':WAVeform:STARt 0',
			':WAVeform:PREamble?',
			':WAVeform:SEQuence?',
			...plan,
			':WAVeform:POINt 2',
			':WAVeform:DATA?',
			RELEASE,
		]);
	});

	// read_frames answered 1000, 0 and 500 for the same ordinary signal on hardware while sum_frames stayed 1.
	it('keys the frame warning off the acquired count and keeps the raw read count with a note', async () => {
		stage({ read_frames: 1000, sum_frames: 1 }, codes([1, 2]));
		const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 2 }));
		const frames = result.frames as Record<string, unknown>;
		expect(frames.read).toBe(1000);
		expect(frames.acquired).toBe(1);
		expect(String(frames.note)).toMatchRegex(/populates inconsistently/);
		expect(!String(result.warnings ?? '').includes('sequence frames')).toBeTruthy();
		harness.fake.sent();
	});

	it('keeps a deliberate lock in place when the server allows locking', async () => {
		harness.scope.allowLock = true;
		try {
			stage({}, codes([1]));
			const result = payload(await call(harness, 'get_waveform', { source: 'C1', points: 1 }));
			expect(!(result.commands as string[]).includes(RELEASE)).toBeTruthy();
			expect(!harness.fake.sent().includes(RELEASE)).toBeTruthy();
		} finally {
			harness.scope.allowLock = false;
		}
	});

	it('refuses an answer that is not a WAVEDESC descriptor', async () => {
		harness.fake.replies.set(':WAVeform:PREamble?', block(Buffer.alloc(346)));
		const refused = await call(harness, 'get_waveform', { source: 'C1', points: 1 });
		expect(refused.isError).toBe(true);
		harness.fake.sent();
	});

	it('refuses a transfer larger than one call carries, before reading any of it', async () => {
		stage({}, codes([1]));
		const refused = await call(harness, 'get_waveform', { source: 'C1', points: 200_000_000 });
		expect(refused.isError).toBe(true);
		expect(!harness.fake.sent().includes(':WAVeform:DATA?')).toBeTruthy();
	});

	it('transfers a math trace after its function answers ON', async () => {
		harness.fake.replies.set(':FUNCtion1?', 'ON');
		stage({}, codes([-11]));
		const result = payload(await call(harness, 'get_waveform', { source: 'F1', points: 1 }));
		expect(result.source).toBe('F1');
		assertSent(harness.fake, [
			':FUNCtion1?',
			':WAVeform:SOURce F1',
			':WAVeform:INTerval 1',
			':WAVeform:STARt 0',
			':WAVeform:PREamble?',
			...plan,
			':WAVeform:POINt 1',
			':WAVeform:DATA?',
			RELEASE,
		]);
	});

	it('refuses a math trace that is off before the transfer starts', async () => {
		harness.fake.replies.set(':FUNCtion2?', 'OFF');
		const refused = await call(harness, 'get_waveform', { source: 'F2', points: 1 });
		expect(refused.isError).toBe(true);
		const error = payload(refused);
		expect(error.kind).toBe('error');
		expect(String(error.error)).toMatchRegex(/F2 is switched off/);
		expect(String(error.warnings)).toMatchRegex(/may never answer/);
		assertSent(harness.fake, [':FUNCtion2?']);
	});

	it('writes nothing when the request is invalid', async () => {
		await assertInvalidSendsNothing(harness, 'get_waveform', {});
		await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'C1', frame: 1, frame_start: 2 });
		await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'MATH' });
		await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'D0' });
		await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'C1', interval: 0 });
	});
});

describe('EN11F waveform on a two-channel model', () => {
	it('refuses a channel the model does not have before writing anything', async () => {
		const harness = await startScpiHarness('SDS802X HD');
		try {
			await call(harness, 'identify');
			harness.fake.sent();
			assertCapabilityError(await call(harness, 'get_waveform', { source: 'C4' }), 'SDS802X HD');
			assertSent(harness.fake, []);
		} finally {
			await harness.close();
		}
	});
});
