import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertSent, payload } from '../../../support/assertions.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const replies = {
	'*OPC?': '1',
	'C1:TRA?': 'ON',
	'C2:TRA?': 'OFF',
	'C3:TRA?': 'OFF',
	'C4:TRA?': 'OFF',
	'C1:VDIV?': '5.00E-01',
	'C1:OFST?': '0.00E+00',
	'C1:CPL?': 'D1M',
	'BWL?': 'C1,OFF,C2,OFF,C3,OFF,C4,OFF',
	'C1:ATTN?': '10',
	'C1:UNIT?': 'V',
	'C1:SKEW?': '0.00E+00S',
	'C1:INVS?': 'OFF',
	'SAST?': "Trig'd",
	'SARA?': '1.00E+09Sa/s',
	'TDIV?': '1.00E-06S',
	'TRDL?': '0.00E+00S',
	'TRMD?': 'AUTO',
	'ACQW?': 'SAMPLING',
	'AVGA?': '16',
	'MSIZ?': '14M',
};

describe('autoset tool', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
	});

	after(() => harness.close());

	it('is not read-only', async () => {
		const { tools } = await harness.client.listTools();
		expect(tools.find((tool) => tool.name === 'autoset_scope')?.annotations?.readOnlyHint).toBe(false);
	});

	it('sends nothing without confirmation', async () => {
		await assertInvalidSendsNothing(harness, 'autoset_scope', {});
	});

	it('runs ASET, waits for completion and reports acquisition and visible channels', async () => {
		harness.fake.sent();
		const result = await harness.client.callTool({ name: 'autoset_scope', arguments: { confirm_autoset: true } });
		const { completed, acquisition, channels } = payload(result) as {
			completed: { completed: boolean };
			acquisition: { status: { state?: string } };
			channels: Array<{ channel: string }>;
		};
		expect(completed.completed).toBe(true);
		expect(acquisition.status.state).toBe("Trig'd");
		expect(channels.length).toBe(1);
		expect(channels[0]?.channel).toBe('C1');
		assertSent(harness.fake, [
			'CHDR OFF',
			'*IDN?',
			'ASET',
			'*OPC?',
			'C1:TRA?',
			'C1:ATTN?',
			'C1:VDIV?',
			'C1:OFST?',
			'C1:CPL?',
			'C1:SKEW?',
			'C1:UNIT?',
			'C1:INVS?',
			'C1:TRA?',
			'BWL?',
			'C2:TRA?',
			'C3:TRA?',
			'C4:TRA?',
			'SAST?',
			'SARA?',
			'TDIV?',
			'TRDL?',
			'TRMD?',
			'ACQW?',
			'AVGA?',
			'MSIZ?',
		]);
	});
});
