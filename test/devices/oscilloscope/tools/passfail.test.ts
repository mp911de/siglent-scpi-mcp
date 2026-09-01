import type { Socket } from 'node:net';
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
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const setup = { 'PFSC?': 'PF_SOURCE C1', 'PFST?': 'PF_SET XMASK,0.40,YMASK,0.52', 'PFBF?': 'PF_BUFFER OFF' };
const mask = { source: 'C1', x_mask: 0.4, y_mask: 0.52, tolerance_raw: setup['PFST?'], buzzer: 'OFF' };

const states = (enabled: string, display: string, stopOnFail: string, running: string) => ({
	'PFEN?': `PF_ENABLE ${enabled}`,
	'PFDS?': `PF_DISPLAY ${display}`,
	'PFFS?': `PF_FAIL_STOP ${stopOnFail}`,
	'PFOP?': `PF_OPERATION ${running}`,
});

const testing = { ...states('ON', 'ON', 'ON', 'ON'), 'PFDD?': 'PF_DATADIS FAIL,2,PASS,3,TOTAL,5' };

const sequence = (...answers: string[]) => {
	let index = 0;
	return (socket: Socket) => void socket.write(`${answers[Math.min(index++, answers.length - 1)]}\n`);
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const warnings = (result: Parameters<typeof payload>[0]) => (payload(result).warnings ?? []) as string[];

const annotations = async (harness: Harness, name: string) => {
	const { tools } = await harness.client.listTools();
	return tools.find((tool) => tool.name === name)?.annotations;
};

async function connect(replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('pass/fail mask tools on SDS1000X-E', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(setup);
	});

	after(() => harness.close());

	it('reads source, both tolerances and the failure alarm', async () => {
		const result = await call(harness, 'get_pass_fail_mask');
		expect(payload(result)).toBeEqual({ ...mask, write_only: ['PACL', 'PFCM'] });
		assertSent(harness.fake, ['PFSC?', 'PFST?', 'PFBF?']);
		await assertReadOnly(harness.client, 'get_pass_fail_mask');
	});

	it('sends source, both tolerances in one PFST and the alarm, then reads them back', async () => {
		const result = await call(harness, 'configure_pass_fail_mask', {
			source: 'C1',
			x_mask: 0.4,
			y_mask: 0.52,
			buzzer: false,
		});
		expect(payload(result).commands).toBeEqual(['PFSC C1', 'PFST XMASK,0.4,YMASK,0.52', 'PFBF OFF']);
		expect(payload(result).state).toBeEqual(mask);
		assertSent(harness.fake, ['PFSC C1', 'PFST XMASK,0.4,YMASK,0.52', 'PFBF OFF', 'PFSC?', 'PFST?', 'PFBF?']);
		expect(warnings(result)).toBeEqual([]);
	});

	it('creates the mask after the setup, enabling the test and stopping it first', async () => {
		const result = await call(harness, 'configure_pass_fail_mask', {
			x_mask: 0.4,
			y_mask: 0.52,
			create_mask: true,
			confirm_replace_mask: true,
		});
		expect(payload(result).commands).toBeEqual(['PFST XMASK,0.4,YMASK,0.52', 'PFEN ON', 'PFOP OFF', 'PFCM']);
		assertSent(harness.fake, ['PFST XMASK,0.4,YMASK,0.52', 'PFEN ON', 'PFOP OFF', 'PFCM', 'PFST?']);
	});

	it('resets the statistics with the single command the guide defines', async () => {
		const result = await call(harness, 'reset_pass_fail_statistics');
		expect(payload(result)).toBeEqual({ commands: ['PACL'] });
		assertSent(harness.fake, ['PACL']);
		expect((await annotations(harness, 'reset_pass_fail_statistics'))?.destructiveHint).toBe(false);
	});

	it('sends nothing for a request the schema rejects', async () => {
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', {});
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { create_mask: true });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', {
			create_mask: true,
			confirm_replace_mask: false,
		});
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { x_mask: 0.4 });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { x_mask: 0.4, y_mask: 0.05 });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { x_mask: 0.02, y_mask: 0.04 });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { x_mask: 4.04, y_mask: 4 });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail_mask', { source: 'C1', buzzer: 'ON' });
	});

	it('is annotated as destructive, because creating a mask replaces the active rule', async () => {
		const hints = await annotations(harness, 'configure_pass_fail_mask');
		expect(hints?.readOnlyHint).toBe(false);
		expect(hints?.destructiveHint).toBe(true);
	});
});

describe('pass/fail mask tools with a scope that answers the tolerance in E-notation', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ ...setup, 'PFST?': 'PF_SET XMASK,4.0E-01,YMASK,5.2E-01' });
	});

	after(() => harness.close());

	it('does not call an E-notation read-back a clamp', async () => {
		const result = await call(harness, 'configure_pass_fail_mask', { x_mask: 0.4, y_mask: 0.52 });
		expect(warnings(result)).toBeEqual([]);
	});
});

describe('pass/fail mask tools with a scope that rounds the tolerance', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ ...setup, 'PFST?': sequence('PF_SET XMASK,0.44,YMASK,0.52') });
	});

	after(() => harness.close());

	it('reports the tolerance the scope kept', async () => {
		const result = await call(harness, 'configure_pass_fail_mask', { x_mask: 0.4, y_mask: 0.52 });
		expect(warnings(result)).toBeEqual(['x_mask was set to 0.4 but the scope reports 0.44']);
	});
});

describe('pass/fail mask tools on SDS2000X', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(setup, 'SDS2102X');
	});

	after(() => harness.close());

	it('never sends a pass/fail command the guide does not list for the family', async () => {
		assertCapabilityError(await call(harness, 'get_pass_fail_mask'), 'SDS2102X');
		assertCapabilityError(await call(harness, 'configure_pass_fail_mask', { x_mask: 0.4, y_mask: 0.52 }), 'SDS2102X');
		assertCapabilityError(await call(harness, 'reset_pass_fail_statistics'), 'SDS2102X');
		assertSent(harness.fake, []);
	});
});

describe('pass/fail mask tools on an unrecognized model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(setup, 'SDS9999Z');
	});

	after(() => harness.close());

	it('reports unknown support and still says what it read', async () => {
		const result = await call(harness, 'get_pass_fail_mask');
		expect(payload(result).source).toBe('C1');
		assertSent(harness.fake, ['PFSC?', 'PFST?', 'PFBF?']);
		assertUnknownWarning(result, 'xe');
	});
});

describe('pass/fail mask tools on a two-channel scope', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(setup, 'SDS1202X-E');
	});

	after(() => harness.close());

	it('refuses a source the scope does not have', async () => {
		assertCapabilityError(await call(harness, 'configure_pass_fail_mask', { source: 'C4' }), 'SDS1202X-E');
		assertSent(harness.fake, []);
	});
});

describe('pass/fail operation tools while a test runs', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(testing);
	});

	after(() => harness.close());

	it('reads the four state flags and the frame counts', async () => {
		const result = await call(harness, 'get_pass_fail');
		expect(payload(result)).toBeEqual({
			enabled: 'ON',
			display: 'ON',
			stop_on_fail: 'ON',
			running: 'ON',
			fail: 2,
			pass: 3,
			total: 5,
			counts_raw: testing['PFDD?'],
		});
		assertSent(harness.fake, ['PFEN?', 'PFDS?', 'PFFS?', 'PFOP?', 'PFDD?']);
		await assertReadOnly(harness.client, 'get_pass_fail');
	});

	it('enables the feature before starting the test and reports the unverifiable mask', async () => {
		const result = await call(harness, 'configure_pass_fail', { running: true });
		expect(payload(result).commands).toBeEqual(['PFEN ON', 'PFOP ON']);
		assertSent(harness.fake, ['PFEN ON', 'PFOP ON', 'PFEN?', 'PFOP?']);
		expect(warnings(result)).toBeEqual([
			'The test uses the active mask. Mask creation has no query form, so the tool cannot confirm that a mask exists.',
		]);
	});

	it('enables the feature before showing the counts', async () => {
		const result = await call(harness, 'configure_pass_fail', { display: true });
		expect(payload(result).commands).toBeEqual(['PFEN ON', 'PFDS ON']);
		assertSent(harness.fake, ['PFEN ON', 'PFDS ON', 'PFEN?', 'PFDS?']);
		expect(warnings(result)).toBeEqual([]);
	});

	it('orders a combined request enable, options, run and reports stop-on-fail', async () => {
		const result = await call(harness, 'configure_pass_fail', {
			enabled: true,
			display: true,
			stop_on_fail: true,
			running: true,
		});
		expect(payload(result).commands).toBeEqual(['PFEN ON', 'PFDS ON', 'PFFS ON', 'PFOP ON']);
		assertSent(harness.fake, ['PFEN ON', 'PFDS ON', 'PFFS ON', 'PFOP ON', 'PFEN?', 'PFDS?', 'PFFS?', 'PFOP?']);
		expect(payload(result).state).toBeEqual({ enabled: 'ON', display: 'ON', stop_on_fail: 'ON', running: 'ON' });
		expect(
			warnings(result).some((warning) => /stops acquisition on the first failed frame/.test(warning)),
		).toBeTruthy();
	});

	it('sends nothing for a request the schema rejects', async () => {
		await assertInvalidSendsNothing(harness, 'configure_pass_fail', {});
		await assertInvalidSendsNothing(harness, 'configure_pass_fail', { enabled: false, running: true });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail', { enabled: false, display: true });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail', { running: 'ON' });
		await assertInvalidSendsNothing(harness, 'configure_pass_fail', { stop_on_fail: 1 });
	});

	it('changes the test state without being destructive', async () => {
		const hints = await annotations(harness, 'configure_pass_fail');
		expect(hints?.readOnlyHint).toBe(false);
		expect(hints?.destructiveHint).toBe(false);
	});
});

describe('pass/fail operation tools while the test is stopped', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ ...states('OFF', 'OFF', 'OFF', 'OFF'), 'PFDD?': 'PF_DATADIS FAIL,0,PASS,0,TOTAL,0' });
	});

	after(() => harness.close());

	it('stops the test before disabling the feature', async () => {
		const result = await call(harness, 'configure_pass_fail', { enabled: false, running: false });
		expect(payload(result).commands).toBeEqual(['PFOP OFF', 'PFEN OFF']);
		assertSent(harness.fake, ['PFOP OFF', 'PFEN OFF', 'PFEN?', 'PFOP?']);
		expect(warnings(result)).toBeEqual([]);
	});

	it('leaves the feature alone when only stop-on-fail is switched off', async () => {
		const result = await call(harness, 'configure_pass_fail', { stop_on_fail: false });
		expect(payload(result).commands).toBeEqual(['PFFS OFF']);
		expect(warnings(result)).toBeEqual([]);
	});

	it('reports a test that did not start, for example without a mask', async () => {
		const result = await call(harness, 'configure_pass_fail', { running: true });
		expect(payload(result).commands).toBeEqual(['PFEN ON', 'PFOP ON']);
		expect(warnings(result).at(-1)).toBeEqual('running was set to true but the scope reports "OFF"');
	});
});

describe('pass/fail counts as different firmware reports them', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			...states('ON', 'ON', 'OFF', 'ON'),
			'PFDD?': sequence('FAIL, 3 ,PASS, 7 ,TOTAL, 10', 'PF_DATADIS FAIL,1,PASS,2', 'PFDD FAIL,3,PASS,4,TOTAL,5'),
		});
	});

	after(() => harness.close());

	it('parses counts without a header and with padding', async () => {
		const result = await call(harness, 'get_pass_fail');
		expect(payload(result).fail).toBeEqual(3);
		expect(payload(result).pass).toBeEqual(7);
		expect(payload(result).total).toBeEqual(10);
	});

	it('never fabricates a count the scope did not report', async () => {
		const counts = payload(await call(harness, 'get_pass_fail'));
		expect(counts.fail).toBe(1);
		expect(counts.pass).toBe(2);
		expect(!('total' in counts)).toBeTruthy();
		expect(counts.counts_raw).toBe('PF_DATADIS FAIL,1,PASS,2');
	});

	it('reports a total that does not cover the failed and passed frames', async () => {
		const result = await call(harness, 'get_pass_fail');
		expect(warnings(result)).toBeEqual(['The scope reports 5 total frames for 3 failed and 4 passed.']);
	});
});

describe('pass/fail operation tools on SDS2000X', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(testing, 'SDS2102X');
	});

	after(() => harness.close());

	it('never sends PFEN, PFDS, PFFS, PFOP or PFDD? to a family the guide does not list', async () => {
		assertCapabilityError(await call(harness, 'get_pass_fail'), 'SDS2102X');
		assertCapabilityError(await call(harness, 'configure_pass_fail', { running: false }), 'SDS2102X');
		assertSent(harness.fake, []);
	});
});
