import { AsyncLocalStorage } from 'node:async_hooks';
import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api';
import pino, { type Bindings, type Logger } from 'pino';
import pkg from '../package.json' with { type: 'json' };
import type { ExchangeInterceptor } from './scpi/connection.ts';

let sink: (line: string) => void = (line) => void process.stderr.write(line);

// The CLI swaps this for a renderer in its quiet default mode; raw NDJSON stays the default everywhere else.
export const setLogSink = (write: (line: string) => void): void => {
	sink = write;
};

export const rootLog: Logger = pino(
	{
		name: pkg.name,
		level: process.env.LOG_LEVEL ?? 'info',
		base: undefined,
		redact: { paths: ['args.password', 'args.*.password'], censor: '***' },
	},
	{ write: (line: string) => sink(line) },
);
export const tracer = trace.getTracer(pkg.name, pkg.version);

const logContext = new AsyncLocalStorage<Logger>();

export const log = (): Logger => logContext.getStore() ?? rootLog;

export const withLogContext = <T>(bindings: Bindings, fn: () => T): T => logContext.run(log().child(bindings), fn);

export const elapsed = (started: number): number => Math.round((performance.now() - started) * 10) / 10;

export function traced<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await fn();
		} catch (error) {
			span.recordException(error as Error);
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
			throw error;
		} finally {
			span.end();
		}
	});
}

export const observeExchange: ExchangeInterceptor = (exchange, run) =>
	traced(`scpi.${exchange.kind}`, { 'scpi.command': exchange.command }, async () => {
		const started = performance.now();
		try {
			const response = await run();
			log().debug({ scpi: { ...exchange, response: summarize(response), ms: elapsed(started) } }, 'scpi exchange');
			return response;
		} catch (error) {
			log().warn({ err: error, scpi: { ...exchange, ms: elapsed(started) } }, 'scpi exchange failed');
			throw error;
		}
	});

function summarize(response: unknown): unknown {
	if (response instanceof Uint8Array) return `<${response.byteLength} bytes>`;
	if (typeof response === 'string' && response.length > 200)
		return `${response.slice(0, 200)}... (${response.length} chars)`;
	return response;
}
