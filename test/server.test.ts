import { createConnection } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { oscilloscope } from '../src/devices/oscilloscope/driver.ts';
import { oscilloscopeScpi } from '../src/devices/oscilloscope-scpi/driver.ts';
import { powerSupply } from '../src/devices/power-supply/driver.ts';
import { unknown } from '../src/devices/unknown.ts';
import { connect, type Harness, startHarness, text } from './support/harness.ts';

// A raw client, because a body the server refuses mid-upload leaves fetch with a broken write and no response.
function rawPost(url: string, headers: readonly string[], chunks: readonly string[]) {
	const { hostname, port, pathname } = new URL(url);
	const socket = createConnection({ host: hostname, port: Number(port) });
	const state = { received: '', timedOut: false };
	socket.on('error', () => {});
	socket.on('data', (chunk) => {
		state.received += chunk.toString();
	});
	socket.setTimeout(5_000, () => {
		state.timedOut = true;
		socket.destroy();
	});
	const write = (data: string) => socket.write(data, () => {});
	write(
		[
			`POST ${pathname} HTTP/1.1`,
			`host: ${hostname}:${port}`,
			'authorization: Bearer secret',
			'content-type: application/json',
			...headers,
			'',
			'',
		].join('\r\n'),
	);
	for (const chunk of chunks) write(chunk);
	return new Promise<typeof state>((resolve) => socket.on('close', () => resolve(state)));
}

describe('server', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ 'C1:VDIV?': '5.00E-01', 'SLOW?': undefined }, 'secret');
	});

	after(() => harness.close());

	it('lists tools with honest annotations', async () => {
		const { tools } = await harness.client.listTools();
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
		expect(byName.get_channel?.annotations?.readOnlyHint).toBe(true);
		expect(byName.configure_channel?.annotations?.readOnlyHint).toBe(false);
		expect(byName.scpi_command?.annotations?.destructiveHint).toBe(true);
	});

	it('identifies the scope and derives capabilities', async () => {
		const result = await harness.client.callTool({ name: 'identify', arguments: {} });
		const identity = JSON.parse(text(result));
		expect(identity.model).toBe('SDS1104X-E');
		expect(identity.capabilities.channels).toBe(4);
		expect(harness.fake.received.slice(0, 2)).toBeEqual(['CHDR OFF', '*IDN?']);
	});

	it('answers raw queries and reports failures as tool errors', async () => {
		const ok = await harness.client.callTool({ name: 'scpi_query', arguments: { command: 'C1:VDIV?' } });
		expect(JSON.parse(text(ok)).response).toBe('5.00E-01');
		expect(JSON.parse(text(ok)).commands).toBeEqual(['C1:VDIV?']);

		const written = await harness.client.callTool({ name: 'scpi_command', arguments: { command: 'C1:VDIV 1V' } });
		expect(JSON.parse(text(written))).toBeEqual({ commands: ['C1:VDIV 1V'] });

		const failed = await harness.client.callTool({
			name: 'scpi_query',
			arguments: { command: 'SLOW?', timeout_ms: 100 },
		});
		expect(failed.isError).toBe(true);
		expect(text(failed)).toMatchRegex(/SLOW\?/);
	});

	it('rejects invalid arguments before touching the scope', async () => {
		const before = harness.fake.received.length;
		const result = await harness.client.callTool({
			name: 'configure_channel',
			arguments: { channel: 'C9', volts_per_div: '1V' },
		});
		expect(result.isError).toBe(true);
		expect(harness.fake.received.length).toBe(before);
	});

	it('requires the bearer token', async () => {
		await expect(connect(harness.server.url)).toBeRejected();
		await expect(connect(harness.server.url, 'wrong')).toBeRejected();
	});

	it('lists the exposed tool names and descriptions at the root', async () => {
		const root = new URL('/', harness.server.url);
		const denied = await fetch(root);
		expect(denied.status).toBe(401);

		const response = await fetch(root, { headers: { authorization: 'Bearer secret' } });
		expect(response.status).toBe(200);
		const { tools } = (await response.json()) as { tools: Array<{ name: string; description: string }> };
		expect(tools.length > 0).toBeTruthy();
		expect(tools.find(({ name }) => name === 'identify')).toBeEqual({
			name: 'identify',
			description:
				'Identify the connected oscilloscope. Returns the manufacturer, model, serial number, firmware, derived family, command dialect, and channel count.',
		});
		expect(
			tools.every(({ name, description }) => typeof name === 'string' && typeof description === 'string'),
		).toBeTruthy();

		const post = await fetch(root, { method: 'POST', headers: { authorization: 'Bearer secret' } });
		expect(post.status).toBe(405);
	});

	it('hides dangerous commands and screenshots unless each category enables them', async () => {
		const defaultHarness = await startHarness({}, 'secret', undefined, {});
		try {
			const names = (await defaultHarness.client.listTools()).tools.map(({ name }) => name);
			expect(names.includes('scpi_command')).toBe(false);
			expect(names.includes('scpi_query')).toBe(false);
			expect(names.includes('calibrate_scope')).toBe(false);
			expect(names.includes('capture_screenshot')).toBe(false);

			const catalogue = await fetch(new URL('/', defaultHarness.server.url), {
				headers: { authorization: 'Bearer secret' },
			});
			const listed = ((await catalogue.json()) as { tools: Array<{ name: string }> }).tools.map(({ name }) => name);
			expect(listed).toBeEqual(names);
		} finally {
			await defaultHarness.close();
		}

		const enabledHarness = await startHarness({}, 'secret', undefined, {
			enableDangerousCommands: true,
			enableScreenshots: true,
		});
		try {
			const names = (await enabledHarness.client.listTools()).tools.map(({ name }) => name);
			expect(names.includes('scpi_command')).toBe(true);
			expect(names.includes('scpi_query')).toBe(true);
			expect(names.includes('capture_screenshot')).toBe(true);
		} finally {
			await enabledHarness.close();
		}

		const disabledHarness = await startHarness({}, 'secret', undefined, {
			enableDangerousCommands: true,
			enableScreenshots: true,
			disabledCommands: ['capture_screenshot'],
			disableSetupCommands: true,
			disableDestructiveCommands: true,
		});
		try {
			const names = (await disabledHarness.client.listTools()).tools.map(({ name }) => name);
			expect(names.includes('capture_screenshot')).toBe(false);
			expect(names.includes('configure_channel')).toBe(false);
			expect(names.includes('scpi_query')).toBe(false);
			expect(names.includes('reset_scope')).toBe(false);
			expect(names.includes('get_channel')).toBe(true);
		} finally {
			await disabledHarness.close();
		}
	});

	it('refuses a body that declares more than the limit', async () => {
		const { received, timedOut } = await rawPost(harness.server.url, ['content-length: 2097152'], []);
		expect(timedOut).toBe(false);
		expect(received).toMatchRegex(/^HTTP\/1\.1 413 /);
		expect(received).toMatchRegex(/\{"error":"request body too large"\}/);
	});

	it('destroys a chunked body that passes the limit without declaring a length', async () => {
		const chunk = `${(64 * 1024).toString(16)}\r\n${'x'.repeat(64 * 1024)}\r\n`;
		const { timedOut } = await rawPost(harness.server.url, ['transfer-encoding: chunked'], Array(64).fill(chunk));
		expect(timedOut).toBe(false);
	});

	it('closes within the shutdown bound while a request is in flight', async () => {
		const slow = await startHarness({ 'SLOW?': undefined }, 'secret');
		const call = slow.client.callTool({ name: 'scpi_query', arguments: { command: 'SLOW?', timeout_ms: 120_000 } });
		const stopped = call.then(
			({ isError }) => isError === true,
			() => true,
		);
		while (!slow.fake.received.includes('SLOW?')) await new Promise((resolve) => setImmediate(resolve));
		const started = performance.now();
		await slow.server.close();
		expect(performance.now() - started < 5_000).toBeTruthy();
		expect(await stopped).toBe(true);
		await slow.client.close().catch(() => {});
		await slow.fake.close();
	});

	it('serves an unauthenticated health check', async () => {
		await harness.client.callTool({ name: 'identify', arguments: {} });
		const response = await fetch(new URL('/healthz', harness.server.url));
		expect(response.status).toBe(200);
		expect(await response.json()).toBeEqual({ status: 'ok', instrument: { connected: true } });
	});
});

// The three name lists this metadata replaced lived in the server, where a new high-impact tool was public until
// somebody remembered to add its name.
describe('tool exposure', () => {
	const gated = {
		dangerous: ['reboot_scope', 'shutdown_scope', 'calibrate_scope', 'configure_lan', 'scpi_command', 'scpi_query'],
		screenshots: ['capture_screenshot'],
		lock: ['lock_front_panel'],
	};
	const drivers = [oscilloscope, oscilloscopeScpi, powerSupply, unknown].map(({ label, tools }) => ({
		label,
		tools: tools.map(({ name, exposure }) => ({ name, exposure })),
	}));

	for (const { label, tools } of drivers) {
		it(`gates exactly the previously listed tools of the ${label}`, () => {
			for (const [gate, names] of Object.entries(gated)) {
				const declared = tools.filter(({ exposure }) => exposure === gate).map(({ name }) => name);
				const listed = tools.filter(({ name }) => names.includes(name)).map(({ name }) => name);
				expect(declared.sort()).toBeEqual(listed.sort());
			}
		});
	}

	it('still has a tool for every gated name', () => {
		const names = new Set(drivers.flatMap(({ tools }) => tools.map(({ name }) => name)));
		for (const name of Object.values(gated).flat()) expect(names.has(name)).toBeTruthy();
	});
});
