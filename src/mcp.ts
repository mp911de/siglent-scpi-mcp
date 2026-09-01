import { McpServer } from '@modelcontextprotocol/server';
import pkg from '../package.json' with { type: 'json' };
import type { Driver } from './devices/index.ts';
import type { Instrument } from './scpi/instrument.ts';
import { registerTools } from './tools/define.ts';

export function createMcpServer<I extends Instrument>(driver: Driver<I>, instrument: I): McpServer {
	const server = new McpServer({ name: pkg.name, version: pkg.version }, { instructions: driver.instructions });
	registerTools(server, instrument, driver.tools);
	return server;
}
