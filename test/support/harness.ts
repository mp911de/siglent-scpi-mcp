import { Client, type ClientOptions, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { oscilloscope } from '../../src/devices/oscilloscope/driver.ts';
import { Scope } from '../../src/devices/oscilloscope/scope.ts';
import { oscilloscopeScpi } from '../../src/devices/oscilloscope-scpi/driver.ts';
import { ScpiScope } from '../../src/devices/oscilloscope-scpi/scope.ts';
import { powerSupply } from '../../src/devices/power-supply/driver.ts';
import { PowerSupply } from '../../src/devices/power-supply/supply.ts';
import type { ExchangeInterceptor } from '../../src/scpi/connection.ts';
import type { Instrument } from '../../src/scpi/instrument.ts';
import { type RunningServer, type ServerConfig, startServer } from '../../src/server.ts';
import { FakeScope, type Reply } from './fake-scope.ts';

export interface Harness {
	fake: FakeScope;
	scope: Scope;
	server: RunningServer;
	client: Client;
	close(): Promise<void>;
}

export interface SupplyHarness {
	fake: FakeScope;
	supply: PowerSupply;
	server: RunningServer;
	client: Client;
	close(): Promise<void>;
}

export interface ScpiHarness {
	fake: FakeScope;
	scope: ScpiScope;
	server: RunningServer;
	client: Client;
	close(): Promise<void>;
}

export async function startScpiHarness(
	model = 'SDS804X HD',
	replies: Record<string, Reply> = {},
	intercept?: ExchangeInterceptor,
): Promise<ScpiHarness> {
	const fake = await FakeScope.start(replies);
	fake.replies.set('*IDN?', `Siglent Technologies,${model},SDS08A0000001,1.2.2.1`);
	const scope = new ScpiScope({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500, intercept });
	const server = await startServer(
		{
			host: '127.0.0.1',
			port: 0,
			path: '/mcp',
			enableDangerousCommands: true,
			enableScreenshots: true,
			enableLock: true,
		},
		oscilloscopeScpi,
		scope,
	);
	const client = await connect(server.url);
	return {
		fake,
		scope,
		server,
		client,
		async close() {
			await client.close();
			await server.close();
			await fake.close();
		},
	};
}

export async function startSupplyHarness(
	model = 'SPD1168X',
	replies: Record<string, Reply> = {},
	intercept?: ExchangeInterceptor,
	config: Partial<ServerConfig> = {},
): Promise<SupplyHarness> {
	const fake = await FakeScope.start(replies);
	fake.replies.set('*IDN?', `Siglent Technologies,${model},SPD00001,2.01.01.06`);
	const supply = new PowerSupply({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500, intercept });
	const server = await startServer(
		{
			host: '127.0.0.1',
			port: 0,
			path: '/mcp',
			enableDangerousCommands: true,
			enableScreenshots: true,
			enableLock: true,
			...config,
		},
		powerSupply,
		supply,
	);
	const client = await connect(server.url);
	return {
		fake,
		supply,
		server,
		client,
		async close() {
			await client.close();
			await server.close();
			await fake.close();
		},
	};
}

export async function startHarness(
	replies: Record<string, Reply> = {},
	token?: string,
	intercept?: ExchangeInterceptor,
	toolExposure: Pick<
		ServerConfig,
		| 'enableDangerousCommands'
		| 'enableScreenshots'
		| 'disabledCommands'
		| 'disableSetupCommands'
		| 'disableDestructiveCommands'
	> = {
		enableDangerousCommands: true,
		enableScreenshots: true,
	},
): Promise<Harness> {
	const fake = await FakeScope.start(replies);
	const scope = new Scope({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500, intercept });
	const server = await startServer(
		{ host: '127.0.0.1', port: 0, path: '/mcp', token, ...toolExposure },
		oscilloscope,
		scope,
	);
	const client = await connect(server.url, token);
	return {
		fake,
		scope,
		server,
		client,
		async close() {
			await client.close();
			await server.close();
			await fake.close();
		},
	};
}

export async function connect(url: string, token?: string, options?: ClientOptions): Promise<Client> {
	const client = new Client({ name: 'test', version: '0.0.0' }, options);
	const headers = token ? { authorization: `Bearer ${token}` } : {};
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
	return client;
}

export async function awaitDisconnect(scope: Instrument): Promise<void> {
	while (scope.connected) await new Promise((resolve) => setImmediate(resolve));
}

export function text(result: { content: unknown }): string {
	const [first] = result.content as Array<{ type: string; text?: string }>;
	return first?.text ?? '';
}
