import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing } from '../../../support/assertions.ts';
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const replies = {
	'C1:VDIV?': '5.00E-01',
	'C1:OFST?': '0.00E+00',
	'C1:CPL?': 'D1M',
	'BWL?': 'C1,OFF,C2,ON,C3,OFF,C4,OFF',
	'C1:TRA?': 'ON',
	'C1:ATTN?': '10',
	'C1:UNIT?': 'V',
	'C1:SKEW?': '3.00E-09S',
	'C1:INVS?': 'OFF',
};

describe('channel tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
	});

	after(() => harness.close());

	it('reads a channel into structured values', async () => {
		const result = await harness.client.callTool({ name: 'get_channel', arguments: { channel: 'C1' } });
		const state = JSON.parse(text(result));
		expect(state.volts_per_div.value).toBe(0.5);
		expect(state.bandwidth_limit).toBe('OFF');
		expect(state.probe_attenuation.value).toBe(10);
		expect(state.skew.value).toBe(3e-9);
		expect(state.inverted).toBe('OFF');
	});

	it('writes skew, unit and inversion scoped to the channel', async () => {
		harness.fake.sent();
		const result = await harness.client.callTool({
			name: 'configure_channel',
			arguments: { channel: 'C1', skew: '3NS', unit: 'A', inverted: true },
		});
		const { commands } = JSON.parse(text(result));
		expect(commands).toBeEqual(['C1:SKEW 3NS', 'C1:UNIT A', 'C1:INVS ON']);
		expect(harness.fake.sent().slice(0, 3)).toBeEqual(commands);
	});

	it('rejects a skew beyond 100 ns without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_channel', { channel: 'C1', skew: '1US' });
		await assertInvalidSendsNothing(harness, 'configure_channel', { channel: 'C1', skew: '3NX' });
	});

	it('writes attenuation first, then reads back', async () => {
		const result = await harness.client.callTool({
			name: 'configure_channel',
			arguments: { channel: 'C1', volts_per_div: '500mV', probe_attenuation: 10, bandwidth_limit: true },
		});
		const { commands, state } = JSON.parse(text(result));
		expect(commands).toBeEqual(['C1:ATTN 10', 'C1:VDIV 500mV', 'BWL C1,ON']);
		expect(state.channel).toBe('C1');
		const index = harness.fake.received.indexOf('C1:ATTN 10');
		expect(harness.fake.received.slice(index, index + 3)).toBeEqual(commands);
	});

	it('rejects a channel the model does not have without writing', async () => {
		const twoChannel = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0001,7.6.1.20' });
		try {
			const result = await twoChannel.client.callTool({ name: 'get_channel', arguments: { channel: 'C3' } });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(/2 channels/);
			expect(twoChannel.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await twoChannel.close();
		}
	});

	it('refuses an empty configuration', async () => {
		const result = await harness.client.callTool({ name: 'configure_channel', arguments: { channel: 'C1' } });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatchRegex(/Provide at least one setting to configure/);
	});
});
