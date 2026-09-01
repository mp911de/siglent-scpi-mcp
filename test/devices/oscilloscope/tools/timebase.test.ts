import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import type { ToolError } from '../../../../src/tools/define.ts';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const replies = {
	'TDIV?': 'TDIV 1.00E-02S',
	'TRDL?': 'TRDL -4.80E-06S',
	'HMAG?': 'HMAG 1.00E-03S',
	'HPOS?': 'HPOS 1.00E-07S',
};

const readback = ['TDIV?', 'TRDL?', 'HMAG?', 'HPOS?'];

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

type Result = Parameters<typeof payload>[0];

const warnings = (result: Result) => (payload(result).warnings ?? []) as string[];

async function connect(extra: Record<string, Reply> = {}, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, ...extra, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('timebase tools on SDS1000X-E', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('reads the main scale, the trigger delay and the zoom window', async () => {
		const state = payload(await call(harness, 'get_timebase'));
		expect(state).toBeEqual({
			time_per_div: { value: 0.01, unit: 'S', raw: 'TDIV 1.00E-02S' },
			trigger_delay: { value: -4.8e-6, unit: 'S', raw: 'TRDL -4.80E-06S' },
			zoom_scale: { value: 0.001, unit: 'S', raw: 'HMAG 1.00E-03S' },
			zoom_position: { value: 1e-7, unit: 'S', raw: 'HPOS 1.00E-07S' },
		});
		assertSent(harness.fake, readback);
		await assertReadOnly(harness.client, 'get_timebase');
	});

	it('sets the main scale before checking and sending the zoom window', async () => {
		const result = payload(
			await call(harness, 'configure_timebase', {
				time_per_div: '10MS',
				trigger_delay: '-4.8E-06S',
				zoom_scale: '1MS',
				zoom_position: '100NS',
			}),
		);
		expect(result.commands).toBeEqual(['TDIV 10MS', 'TRDL -4.8E-06S', 'HMAG 1MS', 'HPOS 100NS']);
		assertSent(harness.fake, ['TDIV 10MS', 'TRDL -4.8E-06S', 'TDIV?', 'HMAG 1MS', 'HPOS 100NS', ...readback]);
		expect(result.warnings).toBe(undefined);
	});

	it('refuses a zoom scale above the main time base, after disclosing what it sent', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_timebase', { zoom_scale: '20MS' });
		expect(result.isError).toBe(true);
		const error = JSON.parse(text(result)) as ToolError;
		expect(error.error).toMatchRegex(/zoom_scale 20MS exceeds the main timebase/);
		expect(error.commands).toBeEqual(['TDIV?']);
		assertSent(harness.fake, ['TDIV?']);
	});

	it('sends the zoom scale unchecked when the main time base does not parse', async () => {
		harness.fake.replies.set('TDIV?', 'TDIV ???');
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_timebase', { zoom_scale: '1MS' });
			assertSent(harness.fake, ['TDIV?', 'HMAG 1MS', 'HMAG?']);
			expect(warnings(result).some((warning) => /sent unchecked/.test(warning))).toBeTruthy();
		} finally {
			harness.fake.replies.set('TDIV?', replies['TDIV?']);
		}
	});

	it('reports a zoom position the scope adjusted', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_timebase', { zoom_position: '0S' });
		assertSent(harness.fake, ['HPOS 0S', 'HPOS?']);
		expect(
			warnings(result).some((warning) =>
				/zoom_position was set to "0S" but the scope reports 1e-7 because the zoom window is kept inside the main sweep/.test(
					warning,
				),
			),
		).toBeTruthy();
	});

	it('refuses the factor form on a family the guide gives time values for', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_timebase', { zoom_scale: 20 });
		assertCapabilityError(result, 'SDS1104X-E');
		expect(JSON.parse(text(result)).error as string).toMatchRegex(/requires zoom_scale as a time value, not a factor/);
		assertSent(harness.fake, []);
	});

	it("sends the guide's own negative delay in microseconds and reports the conflict", async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_timebase', { trigger_delay: '-4.8US' });
		assertSent(harness.fake, ['TRDL -4.8US', 'TRDL?']);
		expect(warnings(result).some((warning) => /Negative subsecond trigger delays/.test(warning))).toBeTruthy();
	});

	it('takes a zoom position without a unit as seconds', async () => {
		harness.fake.sent();
		await call(harness, 'configure_timebase', { zoom_position: '0' });
		assertSent(harness.fake, ['HPOS 0', 'HPOS?']);
	});

	it('sends nothing for a scale outside the guide set, a position with no known unit or an empty request', async () => {
		await assertInvalidSendsNothing(harness, 'configure_timebase', { zoom_scale: '50MS' });
		await assertInvalidSendsNothing(harness, 'configure_timebase', { zoom_position: '5PT' });
		await assertInvalidSendsNothing(harness, 'configure_timebase', {});
	});

	it('annotates the configuration as mutating, not destructive', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'configure_timebase')?.annotations;
		expect(annotations).toBeEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});
});

describe('timebase tools on SDS2000X', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HMAG?': 'HMAG 100', 'HPOS?': 'HPOS -2' }, 'SDS2102X');
	});

	after(() => harness.close());

	it('takes the zoom window as factors', async () => {
		const result = payload(await call(harness, 'configure_timebase', { zoom_scale: 100, zoom_position: -2 }));
		expect(result.commands).toBeEqual(['HMAG 100', 'HPOS -2']);
		assertSent(harness.fake, ['HMAG 100', 'HPOS -2', 'HMAG?', 'HPOS?']);
		expect(result.warnings).toBe(undefined);
		expect((result.state as Record<string, unknown>).zoom_scale).toBeEqual({ value: 100, raw: 'HMAG 100' });
	});

	it('sends nothing for a zoom position factor outside the guide range', async () => {
		await assertInvalidSendsNothing(harness, 'configure_timebase', { zoom_position: 1e21 });
	});

	it('refuses the time form the guide gives SDS1000X-E only', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_timebase', { zoom_position: '100NS' });
		assertCapabilityError(result, 'SDS2102X');
		expect(JSON.parse(text(result)).error as string).toMatchRegex(
			/requires zoom_position as a factor, not a time value/,
		);
		assertSent(harness.fake, []);
	});
});

describe('timebase tools on an unsupported model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HMAG?': 'HMAG 4' }, 'SDS9999ABC');
	});

	after(() => harness.close());

	it('sends the given form unchecked and says both the model and the format are unknown', async () => {
		const result = await call(harness, 'configure_timebase', { zoom_scale: 4 });
		assertSent(harness.fake, ['HMAG 4', 'HMAG?']);
		expect(warnings(result).some((warning) => /unknown zoom value support/.test(warning))).toBeTruthy();
		expect(warnings(result).some((warning) => /not a recognized model/i.test(warning))).toBeTruthy();
	});
});

describe('timebase tools on SDS1000X-C', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({}, 'SDS1102X-C');
	});

	after(() => harness.close());

	it('takes the time form of the xe guide table its family follows, and refuses a factor', async () => {
		const result = payload(await call(harness, 'configure_timebase', { zoom_scale: '1MS' }));
		assertSent(harness.fake, ['TDIV?', 'HMAG 1MS', 'HMAG?']);
		expect(result.warnings).toBe(undefined);

		harness.fake.sent();
		const refused = await call(harness, 'configure_timebase', { zoom_scale: 4 });
		assertCapabilityError(refused, 'SDS1102X-C');
		expect(JSON.parse(text(refused)).error as string).toMatchRegex(/requires zoom_scale as a time value, not a factor/);
		assertSent(harness.fake, []);
	});
});

describe('timebase tools on a newer-dialect model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({}, 'SDS2504X HD');
	});

	after(() => harness.close());

	it('never sends the legacy timebase commands', async () => {
		assertCapabilityError(await call(harness, 'get_timebase'), 'SDS2504X HD');
		await assertInvalidSendsNothing(harness, 'configure_timebase', { time_per_div: '1US' });
	});
});
