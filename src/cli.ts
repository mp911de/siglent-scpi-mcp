#!/usr/bin/env node
import { stdout } from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { command, parseCli, usage } from './cli-options.ts';
import { ansi, error, fail, header, info, ok, renderLog, running, status, warn } from './console.ts';
import { selectDriver } from './devices/index.ts';
import { loadInventory } from './devices/inventory.ts';
import { observeExchange, rootLog, setLogSink } from './observability.ts';
import { Instrument } from './scpi/instrument.ts';
import { ScreenshotStore } from './screenshots.ts';
import { startServer } from './server.ts';

const action = attempt(() => parseCli(process.argv.slice(2)), usageError);
if (action.kind === 'help') exit(0, usage);
if (action.kind === 'version') exit(0, `${command} ${pkg.version}\n`);
const {
	target,
	listen,
	httpPort,
	httpPath,
	token,
	inventory,
	maxResponseTimeout,
	unlock,
	enableDangerousCommands,
	enableScreenshots,
	saveScreenshots,
	enableLock,
	disabledCommands,
	disableSetupCommands,
	disableDestructiveCommands,
	logLevel,
	verbose,
} = action.config;
const inventoryWarnings = inventory ? attempt(() => loadInventory(inventory), usageError) : [];

attempt(() => {
	rootLog.level = verbose ? 'debug' : logLevel;
}, usageError);
// Raw NDJSON belongs to verbose mode and to an explicit log level. The default console renders warnings and errors
// as single lines above the spinner and keeps quiet otherwise.
const rawLogs = verbose || process.argv.includes('--log-level') || process.env.LOG_LEVEL !== undefined;
if (!rawLogs) setLogSink(renderLog);
const endpoint = `http://${listen}:${httpPort}${httpPath}`;

header(`${ansi.grey}>_${ansi.reset} ${ansi.bold}${command}${ansi.reset} ${ansi.grey}${pkg.version}${ansi.reset}`, [
	['instrument', `${target.host}:${target.port}`],
	['listen', endpoint],
	['auth', token ? 'bearer token' : 'none'],
]);
for (const message of inventoryWarnings) warn(message);

const model = await step(`Connection to ${target.host}:${target.port}`, async () => {
	const probe = new Instrument(target, { intercept: observeExchange, maxResponseTimeout });
	try {
		await probe.execute(async () => undefined);
		return probe.identity?.model ?? '';
	} finally {
		await probe.close();
	}
});
const driver = selectDriver(model);
const instrument = driver.create(target, { intercept: observeExchange, expect: model, maxResponseTimeout });
if (saveScreenshots) instrument.screenshots = new ScreenshotStore(saveScreenshots, model);
const locks = { unlock, allowLock: enableLock };
await step(driver.label, () => driver.prepare?.(instrument, locks) ?? instrument.execute(async () => undefined));
describeInstrument();
const server = await step(`Endpoint ${endpoint}`, () =>
	startServer(
		{
			host: listen,
			port: httpPort,
			path: httpPath,
			token,
			enableDangerousCommands,
			enableScreenshots,
			enableLock,
			disabledCommands,
			disableSetupCommands,
			disableDestructiveCommands,
		},
		driver,
		instrument,
	),
);
stdout.write('\n');
const idle = rawLogs ? () => {} : running('MCP Server running', status);
if (rawLogs) info('MCP Server running. Press Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		idle();
		stdout.write('\n');
		info('Shutting down.');
		void server.close().finally(() => process.exit(0));
	});
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
	try {
		const result = await run();
		ok(label);
		return result;
	} catch (cause) {
		fail(label);
		error(message(cause));
		return process.exit(1);
	}
}

function describeInstrument(): void {
	const { identity } = instrument;
	if (!identity) return;
	const { facts, warnings } = driver.describe(instrument);
	const firmware = facts.filter((fact) => fact.startsWith('firmware '));
	const spec = facts.filter((fact) => !fact.startsWith('firmware '));
	const details = [...(spec.length ? [spec.join(', ')] : []), ...firmware.map((fact) => fact.replace(/^f/, 'F'))];
	const clean = stripVTControlCharacters;
	ok(`${clean(identity.manufacturer)} ${ansi.bold}${clean(identity.model)}${ansi.reset}`, details);
	for (const message of warnings) warn(message);
	if (details.length) stdout.write('\n');
}

function attempt<T>(run: () => T, onError: (reason: string) => never): T {
	try {
		return run();
	} catch (cause) {
		return onError(message(cause));
	}
}

function usageError(reason: string): never {
	error(`${reason}\nTry '${command} --help' for more information.`);
	return process.exit(2);
}

function exit(code: number, text: string): never {
	stdout.write(text);
	return process.exit(code);
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
