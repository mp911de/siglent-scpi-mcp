import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertCapabilityError, assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

// The fixtures below are the guide's own worked examples: analog pp. 264-266, digital pp. 267-268, math pp. 269-271.
const block = (data: Buffer, declared = data.length, head = 'C1:WF ALL,'): Buffer =>
	Buffer.concat([
		Buffer.from(`${head}#9${String(declared).padStart(9, '0')}`, 'latin1'),
		data,
		Buffer.from('\n\n', 'latin1'),
	]);

const analogData = Buffer.from([0x02, 0xfc, 0x00, 0x7f]);

const digitalData = (() => {
	const packed = Buffer.alloc(88);
	packed[1] = 0b00000101;
	packed[87] = 0xff;
	return packed;
})();

const mathData = (() => {
	const data = Buffer.alloc(700);
	data[0] = 0xff;
	data[1] = 0x19;
	return data;
})();

const analog: Record<string, Reply> = {
	'C1:VDIV?': 'C1:VDIV 5.00E-01V',
	'C1:OFST?': 'C1:OFST -5.00E-01V',
	'TDIV?': 'TDIV 5.00E-09S',
	'SARA?': 'SARA 1.00E+09Sa/s',
	'WFSU?': 'WFSU SP,0,NP,1000,FP,0',
	'C1:WF? DAT2': block(analogData),
};

const digital: Record<string, Reply> = {
	'TDIV?': 'TDIV 5.00E-08S',
	'DI:SARA?': 'DI:SARA 1.00E+09Sa/s',
	'WFSU?': 'WFSU SP,0,NP,1000,FP,0',
	'D0:WF? DAT2': block(digitalData, 700, 'D0:WF ALL,'),
	'D15:WF? DAT2': block(digitalData, 700, 'D15:WF ALL,'),
};

const math: Record<string, Reply> = {
	'DEF?': "DEF EQN,'C1-C2'",
	'MTVD?': 'MTVD 1.00E+00V',
	'TDIV?': 'TDIV 5.00E-09S',
	'SARA?': 'SARA 5.00E+08Sa/s',
	'SANU? C1': 'SANU 3.50E+01pts',
	'WFSU?': 'WFSU SP,0,NP,0,FP,0',
	'MATH:WF? DAT2': block(mathData, 700, 'MATH:WF ALL,'),
};

const call = (harness: Harness, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name: 'get_waveform', arguments: { source: 'C1', ...args } });

type Result = Parameters<typeof payload>[0];

const warnings = (result: Result) => (payload(result).warnings ?? []) as string[];
const samples = (result: Result, key: 'voltage' | 'state' | 'code' | 'time'): number[] =>
	(payload(result).waveform as Record<string, number[] | undefined>)[key] ?? [];
const truncated = (result: Result) => (payload(result).waveform as { truncated: boolean }).truncated;
const warned = (result: Result, needle: string | RegExp) =>
	expect(
		warnings(result).some((warning) => (typeof needle === 'string' ? warning.includes(needle) : needle.test(warning))),
	).toBeTruthy();

// The fixtures are shared by every test in a suite, so a reply one of them bends is put back however it ends.
async function withReply(harness: Harness, command: string, reply: Reply, work: () => Promise<void>): Promise<void> {
	const original = harness.fake.replies.get(command);
	harness.fake.replies.set(command, reply);
	try {
		await work();
	} finally {
		harness.fake.replies.set(command, original);
	}
}

async function connect(replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await harness.client.callTool({ name: 'identify', arguments: {} });
	harness.fake.sent();
	return harness;
}

describe('waveform tools', () => {
	describe('analog sources', () => {
		let harness: Harness;

		before(async () => {
			harness = await connect(analog);
		});

		after(() => harness.close());

		it('accepts channel as an alias of source', async () => {
			harness.fake.sent();
			const result = await harness.client.callTool({ name: 'get_waveform', arguments: { channel: 'C1' } });
			expect(result.isError).toBe(undefined);
			expect(harness.fake.sent().includes('C1:WF? DAT2')).toBeTruthy();
		});

		it('never falls back to another channel when the source is misspelled or missing', async () => {
			await assertInvalidSendsNothing(harness, 'get_waveform', { chanel: 'C3' });
			await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'C9' });
			const missing = await harness.client.callTool({ name: 'get_waveform', arguments: {} });
			expect(missing.isError).toBe(true);
		});

		it('plans the transfer, reads it back and converts codes the way the guide does', async () => {
			const result = await call(harness);
			assertSent(harness.fake, [
				'C1:VDIV?',
				'C1:OFST?',
				'TDIV?',
				'SARA?',
				'WFSU SP,0,NP,1000,FP,0',
				'WFSU?',
				'C1:WF? DAT2',
			]);
			const body = payload(result);
			expect(body.kind).toBe('analog');
			expect(body.block).toBeEqual({ declared: 4, bytes: 4, points: 4 });
			expect(body.transfer).toBeEqual({
				requested: { sparsing: 0, points: 1000, first_point: 0 },
				applied: { raw: 'WFSU SP,0,NP,1000,FP,0', sparsing: 0, points: 1000, first_point: 0 },
			});
			// 0x02 is the guide's own first point: 2 * (0.5 / 25) - (-0.5) = 0.54 V, and 0xFC is 252 - 255 = -3.
			expect(samples(result, 'voltage')).toBeEqual([0.54, 0.44, 0.5, 3.04]);
			expect(samples(result, 'time')).toBeEqual([-35e-9, -34e-9, -33e-9, -32e-9]);
			expect(truncated(result)).toBe(false);
			expect(warnings(result)).toBeEqual([]);
		});

		it('reports the scaling it used and the resolution it took it from', async () => {
			const result = await call(harness);
			expect(payload(result).scaling).toBeEqual({
				volts_per_division: { value: 0.5, unit: 'V', raw: 'C1:VDIV 5.00E-01V' },
				offset: { value: -0.5, unit: 'V', raw: 'C1:OFST -5.00E-01V' },
				resolution: { bits: 8, codesPerDivision: 25 },
				converted: true,
			});
			expect(payload(result).summary).toBeEqual({ count: 4, min: 0.44, max: 3.04, mean: 1.13 });
		});

		it('sends the sparsing and first point the caller asked for and warns that their timing is unverified', async () => {
			harness.fake.sent();
			await withReply(harness, 'WFSU?', 'WFSU SP,4,NP,10,FP,200', async () => {
				const result = await call(harness, { sparsing: 4, points: 10, first_point: 200 });
				expect(harness.fake.sent().slice(4)).toBeEqual(['WFSU SP,4,NP,10,FP,200', 'WFSU?', 'C1:WF? DAT2']);
				// -(5e-9 * 14 / 2) + (200 + index * 4) * 1e-9
				expect(samples(result, 'time')).toBeEqual([165e-9, 169e-9, 173e-9, 177e-9]);
				warned(result, /timing.*unverified on hardware/i);
			});
		});

		it('warns when the scope reports transfer parameters other than the ones it was given', async () => {
			await withReply(harness, 'WFSU?', 'WFSU SP,0,NP,700,FP,0', async () => {
				warned(await call(harness), 'points was set to 1000 but the scope reports 700');
			});
		});

		it('returns the statistics only, or a csv resource, without changing the transfer', async () => {
			const summary = await call(harness, { output: 'summary' });
			expect(payload(summary).waveform).toBe(undefined);
			expect(payload(summary).summary).toBeEqual({ count: 4, min: 0.44, max: 3.04, mean: 1.13 });

			const csv = await call(harness, { output: 'csv' });
			expect(payload(csv).csv).toBeEqual({ points: 4, truncated: false });
			const [, resource] = csv.content as Array<{ resource: { mimeType: string; text: string } }>;
			expect(resource?.resource.mimeType).toBe('text/csv');
			expect(resource?.resource.text.split('\n').slice(0, 2).join('|')).toBe('time,voltage|-3.5e-8,0.54');
		});

		it('caps the points it returns inline and says so', async () => {
			await withReply(harness, 'C1:WF? DAT2', block(Buffer.alloc(5000, 0x01)), async () => {
				const result = await call(harness, { points: 5000 });
				expect(samples(result, 'voltage').length).toBe(4096);
				expect(truncated(result)).toBe(true);
				expect((payload(result).summary as { count: number }).count).toBe(5000);
				warned(result, /returned 5000 points.*only the first 4096 are included/i);
			});
		});

		it('summarises a record far larger than a call-stack spread survives', async () => {
			const points = 300_000;
			await withReply(harness, 'C1:WF? DAT2', block(Buffer.alloc(points, 0x01)), async () => {
				const result = await call(harness, { points, output: 'summary' });
				expect(result.isError).toBe(undefined);
				expect((payload(result).summary as { count: number }).count).toBe(points);
			});
		});

		// The 16 MiB wire cap has to bound what the tool allocates too: one code array, one converted array and one time
		// array over the whole record is about 25 times the block, from a call that returns 4096 points.
		it('allocates for the points it returns, not for the record the scope sent', async () => {
			const points = 8_000_000;
			await withReply(harness, 'C1:WF? DAT2', block(Buffer.alloc(points, 0x01)), async () => {
				const before = process.memoryUsage().heapUsed;
				const result = await call(harness, { points });
				const grown = process.memoryUsage().heapUsed - before;
				expect(samples(result, 'voltage').length).toBe(4096);
				expect(samples(result, 'time').length).toBe(4096);
				expect((payload(result).summary as { count: number }).count).toBe(points);
				expect(grown < 64 * 1024 * 1024).toBeTruthy();
			});
		});

		it('returns raw codes rather than a voltage when the offset does not read as a number', async () => {
			await withReply(harness, 'C1:OFST?', 'C1:OFST OFF', async () => {
				const result = await call(harness);
				expect((payload(result).waveform as Record<string, unknown>).voltage).toBe(undefined);
				expect(samples(result, 'code')).toBeEqual([2, 252, 0, 127]);
				warned(result, /vertical scale or offset.*could not be read as a number/i);
			});
		});

		it('sends nothing for a source or a transfer plan the guide does not define', async () => {
			await assertInvalidSendsNothing(harness, 'get_waveform', { source: 'C9' });
			await assertInvalidSendsNothing(harness, 'get_waveform', { points: -1 });
			await assertInvalidSendsNothing(harness, 'get_waveform', { points: 14_000_001 });
			await assertInvalidSendsNothing(harness, 'get_waveform', { horizontal_divisions: 0 });
		});

		it('is annotated mutating, because WFSU stays behind on the scope', async () => {
			const { tools } = await harness.client.listTools();
			const annotations = tools.find((tool) => tool.name === 'get_waveform')?.annotations;
			expect(annotations).toBeEqual({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		});
	});

	describe('digital sources', () => {
		let harness: Harness;

		before(async () => {
			harness = await connect(digital);
		});

		after(() => harness.close());

		it('reads the packed block as one bit per point, LSB first', async () => {
			const result = await call(harness, { source: 'D0' });
			assertSent(harness.fake, ['TDIV?', 'DI:SARA?', 'WFSU SP,0,NP,1000,FP,0', 'WFSU?', 'D0:WF? DAT2']);
			const body = payload(result);
			// The guide's example: nine digits give 700 points, and one bit per point makes that 88 bytes.
			expect(body.block).toBeEqual({ declared: 700, bytes: 88, points: 700 });
			expect(body.scaling).toBe(undefined);
			expect(samples(result, 'state').slice(0, 16)).toBeEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
			expect(samples(result, 'time').slice(0, 2)).toBeEqual([-350e-9, -349e-9]);
			expect(samples(result, 'state').length).toBe(700);
			expect(body.summary).toBeEqual({ count: 700, min: 0, max: 1, mean: 0.00857142857143 });
		});

		it('covers every line the guide lists', async () => {
			for (const line of Array.from({ length: 16 }, (_, index) => `D${index}`)) {
				harness.fake.replies.set(`${line}:WF? DAT2`, block(digitalData, 700, `${line}:WF ALL,`));
				const result = await call(harness, { source: line, output: 'summary' });
				expect(harness.fake.sent().at(-1)).toBe(`${line}:WF? DAT2`);
				expect(payload(result).block).toBeEqual({ declared: 700, bytes: 88, points: 700 });
			}
		});

		it('reads the digital sample rate, never SARA?, and asks no channel for volts', async () => {
			await call(harness, { source: 'D15', output: 'summary' });
			const sent = harness.fake.sent();
			expect(sent.includes('DI:SARA?')).toBeTruthy();
			expect(!sent.some((line) => line.includes('SARA?') && !line.startsWith('DI:'))).toBeTruthy();
			expect(!sent.some((line) => line.includes('VDIV') || line.includes('OFST'))).toBeTruthy();
		});
	});

	describe('math sources', () => {
		let harness: Harness;

		before(async () => {
			harness = await connect(math);
		});

		after(() => harness.close());

		it('scales against MTVD without the channel offset and spaces points by the interpolation multiplier', async () => {
			const result = await call(harness, { source: 'MATH', output: 'summary' });
			assertSent(harness.fake, [
				'DEF?',
				'MTVD?',
				'TDIV?',
				'SARA?',
				'SANU? C1',
				'WFSU SP,0,NP,0,FP,0',
				'WFSU?',
				'MATH:WF? DAT2',
			]);
			const timing = payload(result).timing as Record<string, unknown>;
			// 700 block points over 35 acquired points is the guide's multiplier of 20, so 1 / (500 MSa/s * 20) = 0.1 ns.
			expect(timing.interpolation_multiplier).toBe(20);
			expect(timing.interval).toBe(1e-10);
			expect(timing.first_time).toBe(-35e-9);
			expect(payload(result).summary).toBeEqual({ count: 700, min: 0, max: 1, mean: 0.00142857142857 });
		});

		it('takes 0xFF as code 0 and one division as one MTVD, and applies no offset', async () => {
			const result = await call(harness, { source: 'MATH' });
			expect(samples(result, 'voltage').slice(0, 2)).toBeEqual([0, 1]);
			expect(samples(result, 'time').slice(0, 2)).toBeEqual([-35e-9, -34.9e-9]);
			const scaling = payload(result).scaling as Record<string, unknown>;
			expect(scaling.offset).toBe(undefined);
			expect(scaling.volts_per_division).toBeEqual({ value: 1, unit: 'V', raw: 'MTVD 1.00E+00V' });
		});

		it('returns a bounded math transfer without times, because the multiplier is not in it', async () => {
			await withReply(harness, 'WFSU?', 'WFSU SP,0,NP,500,FP,0', async () => {
				const result = await call(harness, { source: 'MATH', points: 500, output: 'summary' });
				const timing = payload(result).timing as Record<string, unknown>;
				expect(timing.interval).toBe(undefined);
				expect(timing.first_time).toBe(undefined);
				warned(result, /bounded Math transfer cannot determine point times/i);
			});
		});

		it('refuses the FFT waveform the guide excludes, before planning anything', async () => {
			await withReply(harness, 'DEF?', "DEF EQN,'FFTC1'", async () => {
				harness.fake.sent();
				const result = await call(harness, { source: 'MATH' });
				assertCapabilityError(result, 'SDS1104X-E');
				assertSent(harness.fake, ['DEF?']);
			});
		});
	});

	describe('capabilities', () => {
		it('never applies the 8-bit conversion to a 12-bit scope', async () => {
			const harness = await connect(analog, 'SDS2504X HD');
			try {
				assertCapabilityError(await call(harness), 'SDS2504X HD');
				assertSent(harness.fake, []);
			} finally {
				await harness.close();
			}
		});

		it('returns raw codes when the model is not in the guide, naming what it would need to convert', async () => {
			const harness = await connect(analog, 'SDS9999Z');
			try {
				const result = await call(harness);
				expect((payload(result).waveform as Record<string, unknown>).voltage).toBe(undefined);
				expect(samples(result, 'code')).toBeEqual([2, 252, 0, 127]);
				expect(samples(result, 'time')).toBeEqual([-35e-9, -34e-9, -33e-9, -32e-9]);
				expect((payload(result).scaling as { converted: boolean }).converted).toBe(false);
				warned(result, /voltage conversion requires 8-bit samples.*raw codes are returned/i);
			} finally {
				await harness.close();
			}
		});

		it('refuses math and the digital lines on a family the guide does not give them to', async () => {
			const harness = await connect({ ...analog, ...digital, ...math }, 'SDS2104X');
			try {
				assertCapabilityError(await call(harness, { source: 'MATH' }), 'SDS2104X');
				assertCapabilityError(await call(harness, { source: 'D3' }), 'SDS2104X');
				assertSent(harness.fake, []);
			} finally {
				await harness.close();
			}
		});

		it('refuses a block bigger than the transfer limit after its header', async () => {
			const harness = await connect({ ...analog, 'C1:WF? DAT2': Buffer.from('C1:WF ALL,#9999999999', 'latin1') });
			try {
				const result = await call(harness, { points: 0, output: 'summary' });
				expect(result.isError).toBe(true);
				expect(payload(result).error as string).toMatchRegex(/999999999 bytes.*transfer limit/);
			} finally {
				await harness.close();
			}
		});
	});
});
