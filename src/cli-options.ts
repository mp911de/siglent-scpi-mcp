import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { parseTarget, type Target } from './scpi/connection.ts';
import { type ScreenshotFormat, screenshotFormats } from './screenshots.ts';
import { isLoopback } from './server.ts';

export const command = Object.keys(pkg.bin)[0] ?? pkg.name;
export const usage = `Usage: ${command} [options...] <host>[:port]
     <host>[:port]         Instrument address, SCPI port defaults to 5025
 -l, --listen <address>    Bind address (default 127.0.0.1)
 -p, --port <port>         HTTP port (default 3000)
     --path <path>         MCP endpoint path (default /mcp)
 -t, --token <token>       Require bearer token (env SIGLENT_MCP_TOKEN)
     --inventory <file>    Additional model families (JSON), merged over the built-in table
     --max-response-timeout <ms>
                           Ceiling for any single instrument response (default 180000)
     --unlock              Clear the front-panel remote lock on connect
     --enable-dangerous-commands
                           Expose reboot, shutdown, calibration, LAN and raw-SCPI tools
     --enable-screenshots  Expose screenshot tools
     --save-screenshots [format]
                           Also save each capture to the working directory as png (default) or bmp
     --enable-lock         Expose tools that can lock the front panel
     --disable-commands <names>
                           Hide comma-separated tool names
     --disable-setup-commands
                           Hide tools whose mutability is setup
     --disable-destructive-commands
                           Hide tools whose mutability is destructive
     --log-level <level>   fatal, error, warn, info, debug or trace (default info)
 -v, --verbose             Log SCPI traffic (same as --log-level debug)
 -h, --help                Show this help and quit
 -V, --version             Show version number and quit

At most 32 requests queue for the instrument. Further calls are rejected at once.
`;

export interface CliConfig {
	target: Target;
	listen: string;
	httpPort: number;
	httpPath: string;
	token?: string;
	inventory?: string;
	maxResponseTimeout: number;
	unlock: boolean;
	enableDangerousCommands: boolean;
	enableScreenshots: boolean;
	saveScreenshots?: ScreenshotFormat;
	enableLock: boolean;
	disabledCommands: string[];
	disableSetupCommands: boolean;
	disableDestructiveCommands: boolean;
	logLevel: string;
	verbose: boolean;
}

export type CliAction = { kind: 'help' } | { kind: 'version' } | { kind: 'run'; config: CliConfig };

interface CliValues {
	listen: string;
	port: string;
	path: string;
	token?: string;
	inventory?: string;
	'max-response-timeout': string;
	unlock?: boolean;
	'enable-dangerous-commands'?: boolean;
	'enable-screenshots'?: boolean;
	'save-screenshots'?: string;
	'enable-lock'?: boolean;
	'disable-commands'?: string;
	'disable-setup-commands'?: boolean;
	'disable-destructive-commands'?: boolean;
	'log-level': string;
	verbose?: boolean;
	help?: boolean;
	version?: boolean;
}

export function parseCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): CliAction {
	const normalized = args.map((arg, index, all) => {
		const next = all[index + 1];
		const valued = next !== undefined && !next.startsWith('-') && index + 2 < all.length;
		return arg === '--save-screenshots' && !valued ? '--save-screenshots=png' : arg;
	});
	let parsed: { values: CliValues; positionals: string[] };
	try {
		parsed = parseArgs({
			args: normalized,
			allowPositionals: true,
			options: {
				listen: { type: 'string', short: 'l', default: '127.0.0.1' },
				port: { type: 'string', short: 'p', default: '3000' },
				path: { type: 'string', default: '/mcp' },
				token: { type: 'string', short: 't', default: env.SIGLENT_MCP_TOKEN },
				inventory: { type: 'string' },
				'max-response-timeout': { type: 'string', default: '180000' },
				unlock: { type: 'boolean' },
				'enable-dangerous-commands': { type: 'boolean' },
				'enable-screenshots': { type: 'boolean' },
				'save-screenshots': { type: 'string' },
				'enable-lock': { type: 'boolean' },
				'disable-commands': { type: 'string' },
				'disable-setup-commands': { type: 'boolean' },
				'disable-destructive-commands': { type: 'boolean' },
				'log-level': { type: 'string', default: env.LOG_LEVEL ?? 'info' },
				verbose: { type: 'boolean', short: 'v' },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean', short: 'V' },
			},
		}) as { values: CliValues; positionals: string[] };
	} catch (cause) {
		throw new Error(message(cause).split('. ')[0] ?? 'Invalid arguments');
	}
	const { values, positionals } = parsed;
	if (values.help) return { kind: 'help' };
	if (values.version) return { kind: 'version' };
	if (positionals.length !== 1) throw new Error('Exactly one instrument address is required.');
	const listen = values.listen ?? '127.0.0.1';
	const token = values.token;
	if (!isLoopback(listen) && !token) {
		throw new Error('Listening on a non-loopback address requires --token or SIGLENT_MCP_TOKEN.');
	}
	return {
		kind: 'run',
		config: {
			target: parseTarget(positionals[0] ?? ''),
			listen,
			httpPort: port(values.port ?? '3000'),
			httpPath: endpointPath(values.path ?? '/mcp'),
			token,
			inventory: values.inventory,
			maxResponseTimeout: milliseconds(values['max-response-timeout'] ?? '180000'),
			unlock: values.unlock === true,
			enableDangerousCommands: values['enable-dangerous-commands'] === true,
			enableScreenshots: values['enable-screenshots'] === true,
			saveScreenshots: screenshotFormat(values['save-screenshots'], values['enable-screenshots']),
			enableLock: values['enable-lock'] === true,
			disabledCommands: commandList(values['disable-commands']),
			disableSetupCommands: values['disable-setup-commands'] === true,
			disableDestructiveCommands: values['disable-destructive-commands'] === true,
			logLevel: values['log-level'] ?? 'info',
			verbose: values.verbose === true,
		},
	};
}

function port(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`Invalid port: ${value}`);
	return parsed;
}

// `/` and `/healthz` are served by the routes above the MCP dispatch, and a value the URL parser rewrites would
// never match the pathname the server compares against.
function endpointPath(value: string): string {
	const rewritten = URL.parse(value, 'http://localhost')?.pathname !== value;
	if (!value.startsWith('/') || value.endsWith('/') || value === '/healthz' || rewritten) {
		throw new Error(`Invalid path: ${value}. Use an absolute path such as /mcp, without a trailing slash.`);
	}
	return value;
}

function milliseconds(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
		throw new Error(`Invalid response timeout: ${value}. Use 1000 to 3600000 milliseconds.`);
	}
	return parsed;
}

function screenshotFormat(value?: string, enabled?: boolean): ScreenshotFormat | undefined {
	if (value === undefined) return undefined;
	const format = screenshotFormats.find((candidate) => candidate === value);
	if (!format) throw new Error(`Invalid screenshot format: ${value}. Use png or bmp.`);
	if (!enabled) throw new Error('--save-screenshots requires --enable-screenshots.');
	return format;
}

function commandList(value?: string): string[] {
	if (value === undefined) return [];
	const commands = value.split(',').map((command) => command.trim());
	if (commands.some((command) => !command)) {
		throw new Error('Disabled command names must be comma-separated and non-empty.');
	}
	return commands;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
