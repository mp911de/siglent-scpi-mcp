import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	assertUnknownWarning,
	payload,
} from '../../../support/assertions.ts';
import { awaitDisconnect, type Harness, startHarness, text } from '../../../support/harness.ts';

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('common and communication header tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ '*OPC?': '1', 'CHDR?': 'OFF', 'SLOW?': undefined });
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('identifies with the raw response', async () => {
		const result = payload(await call(harness, 'identify'));
		expect(result.model).toBe('SDS1104X-E');
		expect(String(result.raw)).toMatchRegex(/^Siglent Technologies,SDS1104X-E/);
		await assertReadOnly(harness.client, 'identify');
	});

	it('waits for completion and accepts only 1', async () => {
		harness.fake.sent();
		expect(payload(await call(harness, 'wait_until_complete'))).toBeEqual({ completed: true, raw: '1' });
		assertSent(harness.fake, ['*OPC?']);
		await assertReadOnly(harness.client, 'wait_until_complete');

		harness.fake.replies.set('*OPC?', '*OPC 1');
		expect(payload(await call(harness, 'wait_until_complete')).completed).toBe(true);

		harness.fake.replies.set('*OPC?', '0');
		const malformed = await call(harness, 'wait_until_complete');
		expect(malformed.isError).toBe(true);
		expect(String(payload(malformed).error)).toMatchRegex(/did not report completion.*"0"/);
		harness.fake.replies.set('*OPC?', '1');
	});

	it('reports a completion timeout with the command', async () => {
		harness.fake.replies.delete('*OPC?');
		try {
			const result = await call(harness, 'wait_until_complete', { timeout_ms: 100 });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(/did not respond within 100 ms/);
			expect(payload(result).commands).toBeEqual(['*OPC?']);
		} finally {
			harness.fake.replies.set('*OPC?', '1');
		}
	});

	it('marks operation complete', async () => {
		await call(harness, 'identify');
		harness.fake.sent();
		expect(payload(await call(harness, 'mark_operation_complete'))).toBeEqual({ commands: ['*OPC'] });
		assertSent(harness.fake, ['*OPC']);
	});

	it('refuses to reset without confirmation', async () => {
		await assertInvalidSendsNothing(harness, 'reset_scope', {});
		await assertInvalidSendsNothing(harness, 'reset_scope', { confirm_reset: false });
	});

	it('resets, waits and re-identifies', async () => {
		const { tools } = await harness.client.listTools();
		expect(tools.find((tool) => tool.name === 'reset_scope')?.annotations?.destructiveHint).toBe(true);
		harness.fake.replies.set('*IDN?', 'Siglent Technologies,SDS1204X-E,SDS1EBAC0L0099,7.6.1.15');
		harness.fake.sent();
		try {
			const result = payload(await call(harness, 'reset_scope', { confirm_reset: true }));
			assertSent(harness.fake, ['*RST', '*OPC?', 'CHDR OFF', '*IDN?']);
			expect(result.commands).toBeEqual(['*RST']);
			expect(result.reset).toBeEqual({ completed: true, raw: '1' });
			expect((result.identity as { model: string }).model).toBe('SDS1204X-E');
			expect(harness.scope.identity?.serial).toBe('SDS1EBAC0L0099');
		} finally {
			harness.fake.replies.set('*IDN?', 'Siglent Technologies,SDS1104X-E,SDS1EBAC0L0098,7.6.1.20');
		}
	});

	it('reads the header mode', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'get_communication_header'));
		expect(result.mode).toBe('OFF');
		expect(result.raw).toBe('OFF');
		assertSent(harness.fake, ['CHDR?']);
		await assertReadOnly(harness.client, 'get_communication_header');
	});

	it('rejects an undocumented header mode', async () => {
		await assertInvalidSendsNothing(harness, 'configure_communication_header', { mode: 'BOTH' });
	});

	it('configures the header, reads it back and re-applies it on reconnect', async () => {
		harness.fake.replies.set('CHDR?', 'COMM_HEADER LONG');
		harness.fake.sent();
		try {
			const result = payload(await call(harness, 'configure_communication_header', { mode: 'LONG' }));
			assertSent(harness.fake, ['CHDR LONG', 'CHDR?']);
			expect(result.mode).toBe('LONG');
			expect(result.raw).toBe('COMM_HEADER LONG');
			expect(harness.scope.header).toBe('LONG');

			harness.fake.dropConnections();
			await awaitDisconnect(harness.scope);
			await call(harness, 'identify');
			expect(harness.fake.sent().slice(0, 2)).toBeEqual(['CHDR LONG', '*IDN?']);
		} finally {
			harness.fake.replies.set('CHDR?', 'OFF');
			await call(harness, 'configure_communication_header', { mode: 'OFF' });
		}
	});

	it('fails a header change whose readback cannot be parsed', async () => {
		harness.fake.replies.set('CHDR?', '****');
		try {
			const result = await call(harness, 'configure_communication_header', { mode: 'SHORT' });
			expect(result.isError).toBe(true);
			expect(String(payload(result).error)).toMatchRegex(/communication header mode.*"\*\*\*\*"/);
			expect(harness.scope.header).toBe('OFF');
		} finally {
			harness.fake.replies.set('CHDR?', 'OFF');
		}
	});
});

describe('typed tools with SHORT and LONG headers', () => {
	it('parses headed responses', async () => {
		const harness = await startHarness({
			'C1:VDIV?': 'C1:VOLT_DIV 5.00E-01V',
			'C1:OFST?': 'C1:OFST 0.00E+00V',
			'C1:CPL?': 'C1:CPL D1M',
			'BWL?': 'BWL C1,OFF,C2,ON,C3,OFF,C4,OFF',
			'C1:TRA?': 'C1:TRACE ON',
			'C1:ATTN?': 'C1:ATTN 10',
			'C1:UNIT?': 'C1:UNIT V',
			'C1:SKEW?': 'C1:SKEW 3.00E-09S',
			'C1:INVS?': 'C1:INVERTSET OFF',
			'SAST?': "SAST Trig'd",
			'SARA?': 'SARA 1.00E+09Sa/s',
			'TDIV?': 'TDIV 1.00E-06S',
			'TRDL?': 'TRDL 0.00E+00S',
			'TRMD?': 'TRIG_MODE AUTO',
			'ACQW?': 'ACQUIRE_WAY AVERAGE,16',
			'AVGA?': 'AVERAGE_ACQUIRE 16',
			'MSIZ?': 'MEMORY_SIZE 14M',
			'SXSA?': 'SINXX_SAMPLE ON',
			'XYDS?': 'XY_DISPLAY OFF',
		});
		try {
			const channel = payload(await call(harness, 'get_channel', { channel: 'C1' })) as Record<string, unknown>;
			expect((channel.volts_per_div as { value: number }).value).toBe(0.5);
			expect(channel.coupling).toBe('D1M');
			expect(channel.trace).toBe('ON');
			expect(channel.unit).toBe('V');
			expect((channel.skew as { value: number }).value).toBe(3e-9);
			expect(channel.inverted).toBe('OFF');
			const acquisition = payload(await call(harness, 'get_acquisition'));
			expect(acquisition.status).toBeEqual({ state: "Trig'd", raw: "SAST Trig'd" });
			expect(acquisition.trigger_mode).toBe('AUTO');
			expect((acquisition.sample_rate as { value: number }).value).toBe(1e9);
			expect(acquisition.acquisition_mode).toBeEqual({
				mode: 'AVERAGE',
				average_count: 16,
				raw: 'ACQUIRE_WAY AVERAGE,16',
			});
			expect(acquisition.memory_depth).toBeEqual({ size: '14M', raw: 'MEMORY_SIZE 14M' });
			expect(acquisition.acquisition_mode).toBeEqual({
				mode: 'AVERAGE',
				average_count: 16,
				raw: 'ACQUIRE_WAY AVERAGE,16',
			});
			expect(acquisition.memory_depth).toBeEqual({ size: '14M', raw: 'MEMORY_SIZE 14M' });
		} finally {
			await harness.close();
		}
	});

	it('warns about unknown header support on unrecognized models', async () => {
		const harness = await startHarness({ '*IDN?': 'Siglent Technologies,SDS9999,SDS1EBAC0L0001,1.0', 'CHDR?': 'OFF' });
		try {
			assertUnknownWarning(await call(harness, 'get_communication_header'), 'recognized model');
		} finally {
			await harness.close();
		}
	});
});

const annotationsOf = async (harness: Harness, name: string) => {
	const { tools } = await harness.client.listTools();
	return tools.find((tool) => tool.name === name)?.annotations;
};

describe('self-calibration', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ '*CAL?': '*CAL 0' });
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('sends nothing without an acknowledgement', async () => {
		await assertInvalidSendsNothing(harness, 'calibrate_scope', {});
		await assertInvalidSendsNothing(harness, 'calibrate_scope', { confirm_inputs_disconnected: false });
		await assertInvalidSendsNothing(harness, 'calibrate_scope', {
			confirm_inputs_disconnected: true,
			timeout_ms: 5_000,
		});
	});

	it('calibrates, reports the disabled front panel and is never read-only', async () => {
		const annotations = await annotationsOf(harness, 'calibrate_scope');
		expect(annotations?.readOnlyHint ?? false).toBe(false);
		expect(annotations?.destructiveHint).toBe(true);
		harness.fake.sent();
		const result = payload(await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true }));
		assertSent(harness.fake, ['*CAL?']);
		expect(result.commands).toBeEqual(['*CAL?']);
		expect(result.calibrated).toBe(true);
		expect(result.code).toBe(0);
		expect(result.raw).toBe('*CAL 0');
		expect(typeof result.duration_ms === 'number').toBeTruthy();
		expect((result.warnings as string[]).join()).toMatchRegex(/front-panel keys/);
	});

	it('waits for a calibration that outlasts the default query timeout', async () => {
		harness.fake.replies.set('*CAL?', (socket) => void setTimeout(() => socket.write('*CAL 0\n'), 900));
		try {
			const result = payload(
				await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true, timeout_ms: 10_000 }),
			);
			expect(result.calibrated).toBe(true);
			expect((result.duration_ms as number) > 500).toBeTruthy();
		} finally {
			harness.fake.replies.set('*CAL?', '*CAL 0');
		}
	});

	it('fails on any result but the documented 0 and still discloses what it did', async () => {
		harness.fake.replies.set('*CAL?', '*CAL 1');
		try {
			const result = await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true });
			expect(result.isError).toBe(true);
			const failure = payload(result);
			expect(failure.error).toBe('Self-calibration did not report success: "*CAL 1"');
			expect(failure.commands).toBeEqual(['*CAL?']);
			expect((failure.warnings as string[]).join()).toMatchRegex(/front-panel keys/);
		} finally {
			harness.fake.replies.set('*CAL?', '*CAL 0');
		}
	});
});

describe('network address tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ 'CONET?': 'COMM_NET 10,11,0,230' });
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the address', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'get_network_address'));
		assertSent(harness.fake, ['CONET?']);
		expect(result).toBeEqual({ address: '10.11.0.230', raw: 'COMM_NET 10,11,0,230' });
		await assertReadOnly(harness.client, 'get_network_address');
	});

	it('keeps an answer outside the guide grammar as raw only', async () => {
		harness.fake.replies.set('CONET?', '0,0,0,0');
		try {
			expect(payload(await call(harness, 'get_network_address'))).toBeEqual({ raw: '0,0,0,0' });
		} finally {
			harness.fake.replies.set('CONET?', 'COMM_NET 10,11,0,230');
		}
	});

	it('sends nothing for an address the guide does not allow', async () => {
		for (const address of [
			'127.0.0.1',
			'224.0.0.1',
			'0.11.0.230',
			'10.11.0.256',
			'10.11.0',
			'010.11.0.230',
			'10.11.0.230,1',
			'10.11.0.230; CONET 1,2,3,4',
			'10.11.0.230\nCONET 1,2,3,4',
		]) {
			await assertInvalidSendsNothing(harness, 'change_scope_ip', { address, confirm_disconnect: true });
		}
	});

	it('sends nothing without an acknowledgement', async () => {
		await assertInvalidSendsNothing(harness, 'change_scope_ip', { address: '10.11.0.231' });
		await assertInvalidSendsNothing(harness, 'change_scope_ip', { address: '10.11.0.231', confirm_disconnect: false });
	});

	it('leaves the connection alone when the scope already has the address', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'change_scope_ip', { address: '10.11.0.230', confirm_disconnect: true }),
		);
		assertSent(harness.fake, ['CONET?']);
		expect(result.changed).toBe(false);
		expect(result.commands).toBeEqual([]);
		expect(harness.scope.connected).toBe(true);
	});
});

describe('changing the scope address', () => {
	it('writes the address, retires the connection and fails every later call', async () => {
		const harness = await startHarness({ 'CONET?': 'COMM_NET 10,11,0,230' });
		try {
			await call(harness, 'identify');
			expect((await annotationsOf(harness, 'change_scope_ip'))?.destructiveHint).toBe(true);
			harness.fake.sent();
			const result = payload(
				await call(harness, 'change_scope_ip', { address: '10.11.0.231', confirm_disconnect: true }),
			);
			assertSent(harness.fake, ['CONET?', 'CONET 10,11,0,231']);
			expect(result.changed).toBe(true);
			expect(result.previous).toBeEqual({ address: '10.11.0.230', raw: 'COMM_NET 10,11,0,230' });
			expect(result.target).toBeEqual({ host: '10.11.0.231', port: harness.fake.port });
			expect(String(result.read_back)).toMatchRegex(/^Skipped/);
			expect(String(result.reconnect)).toMatchRegex(/Restart the server with 10\.11\.0\.231/);
			expect((result.warnings as string[]).join()).toMatchRegex(/DHCP/);

			await awaitDisconnect(harness.scope);
			const later = await call(harness, 'identify');
			expect(later.isError).toBe(true);
			expect(String(payload(later).error)).toMatchRegex(/moved to 10\.11\.0\.231/);
			assertSent(harness.fake, []);
		} finally {
			await harness.close();
		}
	});
});
