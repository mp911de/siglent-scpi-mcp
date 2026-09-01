import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { expect } from '@assertive-ts/core';
import pkg from '../package.json' with { type: 'json' };
import { type CliConfig, parseCli } from '../src/cli-options.ts';
import { FakeScope } from './support/fake-scope.ts';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

async function run(...args: string[]): Promise<{ code: number; out: string }> {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args], {
			env: { ...process.env, LOG_LEVEL: 'silent', NO_COLOR: '1' },
		});
		return { code: 0, out: stdout + stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout: string; stderr: string };
		return { code: failure.code ?? -1, out: failure.stdout + failure.stderr };
	}
}

function config(...args: string[]): CliConfig {
	const action = parseCli([...args, '127.0.0.1'], {});
	if (action.kind !== 'run') throw new Error(`Expected run configuration, got ${action.kind}`);
	return action.config;
}

function failure(...args: string[]): string {
	try {
		parseCli(args, {});
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
	throw new Error(`Expected ${args.join(' ')} to be rejected`);
}

describe('command line', () => {
	it('prints the complete help text', async () => {
		const { code, out } = await run('--help');
		expect(code).toBe(0);
		for (const expected of [
			/^Usage: siglent-scpi-mcp /,
			/--inventory <file>/,
			/--max-response-timeout <ms>/,
			/--unlock\s+Clear the front-panel remote lock on connect/,
			/--enable-dangerous-commands/,
			/--enable-screenshots/,
			/--save-screenshots \[format\]/,
			/--enable-lock\s+Expose tools that can lock the front panel/,
			/--disable-commands/,
			/--disable-setup-commands/,
			/--disable-destructive-commands/,
			/--log-level <level>/,
			/At most 32 requests queue for the instrument/,
		]) {
			expect(out).toMatchRegex(expected);
		}
	});

	it('reports the executable name and package version', async () => {
		const { code, out } = await run('--version');
		expect(code).toBe(0);
		expect(out).toBe(`siglent-scpi-mcp ${pkg.version}\n`);
	});

	it('reports a parsing failure with the CLI exit code and help hint', async () => {
		const { code, out } = await run('--path', 'mcp', '127.0.0.1');
		expect(code).toBe(2);
		expect(out).toMatchRegex(/Invalid path: mcp/);
		expect(out).toMatchRegex(/Try 'siglent-scpi-mcp --help'/);
	});

	it('rejects a value attached to a boolean option', () => {
		expect(failure('--enable-screenshots=capture_screenshot', '127.0.0.1')).toMatchRegex(/does not take an argument/);
	});

	it('rejects a screenshot format other than png or bmp', () => {
		expect(failure('--enable-screenshots', '--save-screenshots', 'jpg', '127.0.0.1')).toMatchRegex(
			/Invalid screenshot format: jpg\. Use png or bmp\./,
		);
	});

	it('refuses --save-screenshots without --enable-screenshots', () => {
		expect(failure('--save-screenshots', '127.0.0.1')).toMatchRegex(/requires --enable-screenshots/);
		expect(failure('--save-screenshots=bmp', '127.0.0.1')).toMatchRegex(/requires --enable-screenshots/);
	});

	it('accepts the bare screenshot flag and the explicit format', () => {
		expect(config('--enable-screenshots', '--save-screenshots').saveScreenshots).toBe('png');
		expect(config('--enable-screenshots', '--save-screenshots', 'bmp').saveScreenshots).toBe('bmp');
	});

	it('rejects an endpoint path that cannot dispatch', () => {
		for (const value of ['mcp', '/', '/healthz', '/mcp/', '/mcp?query', '/mcp#fragment', '//mcp', '/a b']) {
			expect(failure('--path', value, '127.0.0.1')).toMatchRegex(/Invalid path/);
		}
	});

	it('accepts a non-default endpoint path', () => {
		expect(config('--path', '/tools/mcp').httpPath).toBe('/tools/mcp');
	});

	it('rejects a response timeout that is not a plain millisecond count', () => {
		for (const value of ['abc', '0', '7200000', '1500.5']) {
			expect(failure('--max-response-timeout', value, '127.0.0.1')).toMatchRegex(/Invalid response timeout/);
		}
	});

	it('applies the ceiling it was given to the instrument connection', async () => {
		const fake = await FakeScope.start({ '*IDN?': undefined });
		try {
			const started = performance.now();
			const { code, out } = await run('--max-response-timeout', '1000', `127.0.0.1:${fake.port}`);
			expect(code).toBe(1);
			expect(out).toMatchRegex(/did not respond within 1000 ms/);
			expect(performance.now() - started < 4_000).toBeTruthy();
		} finally {
			await fake.close();
		}
	});
});
