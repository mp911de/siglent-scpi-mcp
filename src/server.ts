import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Driver } from './devices/index.ts';
import { createMcpServer } from './mcp.ts';
import { log } from './observability.ts';
import type { Instrument } from './scpi/instrument.ts';
import type { Exposure } from './tools/define.ts';

export interface ServerConfig {
	host: string;
	port: number;
	path: string;
	token?: string;
	enableDangerousCommands?: boolean;
	enableScreenshots?: boolean;
	enableLock?: boolean;
	disabledCommands?: readonly string[];
	disableSetupCommands?: boolean;
	disableDestructiveCommands?: boolean;
}

const gates = {
	dangerous: 'enableDangerousCommands',
	screenshots: 'enableScreenshots',
	lock: 'enableLock',
} as const satisfies Record<Exposure, keyof ServerConfig>;

// The operational limits of the HTTP surface. Tool arguments are small, the large payloads travel the other way, so
// no legitimate call approaches the body limit and it stays a constant rather than one more flag to get wrong.
const maxRequestBytes = 1024 * 1024;
const shutdownGrace = 2_000;

export interface RunningServer {
	url: string;
	close(): Promise<void>;
}

type Guard = (req: IncomingMessage, res: ServerResponse) => boolean;

export const isLoopback = (host: string): boolean => ['127.0.0.1', 'localhost', '::1'].includes(host);

export async function startServer<I extends Instrument>(
	config: ServerConfig,
	driver: Driver<I>,
	instrument: I,
): Promise<RunningServer> {
	const onerror = (error: Error) => log().error({ err: error }, 'mcp handler error');
	const tools = exposedTools(driver, config);
	const handler = createMcpHandler(() => createMcpServer({ ...driver, tools }, instrument), { onerror });
	const mcp = toNodeHandler(handler, { onerror });
	const guards: Guard[] = [bearerAuth(config.token)];
	if (isLoopback(config.host)) guards.push(localhostHostValidation(), localhostOriginValidation());
	guards.push(bodyLimit);

	const http = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (path === '/healthz') return json(res, 200, { status: 'ok', instrument: { connected: instrument.connected } });
		if (path === '/') {
			if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
			if (guards.every((guard) => guard(req, res))) {
				return json(res, 200, { tools: tools.map(({ name, description }) => ({ name, description })) });
			}
			return;
		}
		if (path !== config.path) return json(res, 404, { error: 'not found' });
		if (guards.every((guard) => guard(req, res))) void mcp(req, res);
	});
	await once(http.listen(config.port, config.host), 'listening');

	const { address, port } = http.address() as AddressInfo;
	const url = `http://${address.includes(':') ? `[${address}]` : address}:${port}${config.path}`;
	return {
		url,
		// A transfer in flight holds the serialized SCPI queue for as long as the instrument takes, so shutdown gives
		// the work in flight a grace period and then retires the connection out from under it.
		async close() {
			http.close();
			http.closeIdleConnections();
			await within(handler.close());
			instrument.retire('The server is shutting down.');
			http.closeAllConnections();
			await within(instrument.close());
		},
	};
}

function within(work: Promise<unknown>): Promise<unknown> {
	return Promise.race([work.catch(() => undefined), new Promise((done) => setTimeout(done, shutdownGrace).unref())]);
}

function exposedTools<I extends Instrument>(driver: Driver<I>, config: ServerConfig) {
	return driver.tools.filter(({ name, annotations, exposure }) => {
		if (config.disabledCommands?.includes(name)) return false;
		if (config.disableDestructiveCommands && annotations.destructiveHint === true) return false;
		if (config.disableSetupCommands && annotations.readOnlyHint === false && annotations.destructiveHint !== true) {
			return false;
		}
		return exposure === undefined || config[gates[exposure]] === true;
	});
}

// The SDK adapter concatenates the whole body before it validates anything, so the limit is enforced here. A declared
// length is refused before a byte of it arrives. A chunked body is counted on the socket, which the HTTP parser reads
// and the adapter's own read of the request stream does not, and is dropped mid-transfer: the handler already holds
// the response by then, and a client still writing its body cannot read one anyway.
function bodyLimit(req: IncomingMessage, res: ServerResponse): boolean {
	const declared = req.headers['content-length'];
	if (declared !== undefined) {
		if (Number(declared) <= maxRequestBytes) return true;
		json(res, 413, { error: 'request body too large' });
		req.destroy();
		return false;
	}
	if (req.method === 'GET' || req.method === 'HEAD') return true;
	const start = req.socket.bytesRead;
	const count = () => {
		if (req.socket.bytesRead - start > maxRequestBytes) req.destroy();
	};
	req.socket.on('data', count);
	req.once('close', () => req.socket.off('data', count));
	return true;
}

function bearerAuth(token?: string): Guard {
	const expected = token ? Buffer.from(`Bearer ${token}`) : undefined;
	return (req, res) => {
		if (!expected) return true;
		const given = Buffer.from(req.headers.authorization ?? '');
		if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
		res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
		return false;
	};
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
