import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { log } from '../observability.ts';
import { type Frame, type FrameReader, readBinary, readText } from './codec.ts';

export interface Target {
	host: string;
	port: number;
}

export function parseTarget(address: string, defaultPort = 5025): Target {
	const url = URL.parse(`tcp://${address}`);
	if (!url?.hostname || url.pathname || url.search || url.hash || url.username) {
		throw new Error(`Invalid instrument address: ${address}. Use a hostname or IP address with an optional port.`);
	}
	return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : defaultPort };
}

export interface ConnectionOptions {
	connectTimeout?: number;
	queryTimeout?: number;
	binaryTimeout?: number;
	maxResponseTimeout?: number;
	maxResponseBytes?: number;
	maxQueueDepth?: number;
	onConnect?: (session: ScpiSession) => Promise<void>;
}

export interface Exchange {
	kind: 'command' | 'query' | 'binary';
	command: string;
}

export type ExchangeInterceptor = <T>(exchange: Exchange, run: () => Promise<T>) => Promise<T>;

export interface ScpiSession {
	// `echo` stands in for the line in logs, spans and the sent record when the real one carries a secret.
	command(command: string, payload?: Buffer, echo?: string): Promise<void>;
	query(command: string, timeout?: number): Promise<string>;
	queryBinary(command: string, timeout?: number, read?: FrameReader): Promise<Buffer>;
}

export class ScpiError extends Error {}

export class CancelledError extends ScpiError {
	readonly sent: readonly string[];

	constructor(sent: readonly string[]) {
		super(
			sent.length
				? 'Request cancelled after one or more commands were sent. Those commands may already have taken effect.'
				: 'Request cancelled before any command was sent',
		);
		this.sent = [...sent];
	}
}

interface Transaction {
	signal?: AbortSignal;
	sent: string[];
}

const transaction = new AsyncLocalStorage<Transaction>();
const collected = new AsyncLocalStorage<string[]>();

export const withWarnings = <T>(warnings: string[], fn: () => T): T => collected.run(warnings, fn);

// The warnings of the tool call this code runs inside, for helpers that carry no instrument reference.
export const warn = (message: string): void => {
	const warnings = collected.getStore();
	if (warnings && !warnings.includes(message)) warnings.push(message);
};

// `sent` collects every line the scope received, so a caller whose request fails part way learns what was applied.
export const withCancellation = <T>(signal: AbortSignal, fn: () => T, sent: string[] = []): T =>
	transaction.run({ signal, sent }, fn);

// The signal of the request the caller is running inside, so that whether a cancellation has landed is observable and
// not merely inferred from how long something took.
export const requestSignal = (): AbortSignal | undefined => transaction.getStore()?.signal;

interface Pending {
	read: FrameReader;
	resolve: (payload: Buffer) => void;
	reject: (error: Error) => void;
	done: () => void;
}

// The operational limits of the single serialized instrument connection. `--max-response-timeout` overrides the
// ceiling that bounds every individual exchange, however long a tool or a caller asks to wait.
const defaults = {
	connectTimeout: 5_000,
	queryTimeout: 5_000,
	binaryTimeout: 30_000,
	maxResponseTimeout: 180_000,
	maxResponseBytes: 64 * 1024 * 1024,
	maxQueueDepth: 32,
};

export class ScpiConnection {
	readonly target: Target;
	readonly #options: typeof defaults & ConnectionOptions;
	readonly #intercept: ExchangeInterceptor;
	#socket?: Socket;
	#buffer: Buffer = Buffer.alloc(0);
	#filled = 0;
	#pending?: Pending;
	#current?: Transaction;
	#retired?: string;
	#queue: Promise<unknown> = Promise.resolve();
	#depth = 0;

	readonly #session: ScpiSession = {
		command: (command, payload, echo) =>
			this.#intercept(
				{ kind: 'command', command: echo ?? (payload ? `${command} <${payload.length} bytes>` : command) },
				() => this.#write(command, payload, echo),
			),
		query: (command, timeout = this.#options.queryTimeout) =>
			this.#intercept({ kind: 'query', command }, async () =>
				(await this.#exchange(command, readText, timeout)).toString('latin1').trim(),
			),
		queryBinary: (command, timeout = this.#options.binaryTimeout, read = readBinary) =>
			this.#intercept({ kind: 'binary', command }, () => this.#exchange(command, read, timeout)),
	};

	constructor(target: Target, options: ConnectionOptions = {}, intercept: ExchangeInterceptor = (_, run) => run()) {
		this.target = target;
		this.#options = { ...defaults, ...options };
		this.#intercept = intercept;
	}

	get connected(): boolean {
		return this.#socket !== undefined;
	}

	// A slot is taken before the work joins the chain and given back when it settles, so a rejected, failed or
	// cancelled transaction leaves the depth where it found it.
	execute<T>(work: (session: ScpiSession) => Promise<T>): Promise<T> {
		const { maxQueueDepth } = this.#options;
		if (this.#depth >= maxQueueDepth) {
			return Promise.reject(
				new ScpiError(
					`The instrument already has ${maxQueueDepth} requests queued, its limit. Retry once the work in flight has finished.`,
				),
			);
		}
		this.#depth += 1;
		const request = transaction.getStore();
		const result = this.#queue.then(async () => {
			this.#current = request ?? { sent: [] };
			try {
				if (this.#retired) throw new ScpiError(this.#retired);
				const cancelled = this.#cancelled();
				if (cancelled) throw cancelled;
				if (!this.#socket) await this.#connect();
				return await work(this.#session);
			} finally {
				this.#current = undefined;
			}
		});
		this.#queue = result.catch(() => undefined);
		return result.finally(() => {
			this.#depth -= 1;
		});
	}

	// Moving the scope to another address leaves this socket pointing at a target that is no longer the scope. The
	// connection is retired rather than reconnected, so no later work reaches the old address or a stranger at it.
	retire(reason: string): void {
		this.#retired = reason;
		this.#teardown(new ScpiError(reason));
	}

	async close(): Promise<void> {
		await this.#queue;
		this.#teardown(new ScpiError('Connection closed'));
	}

	async #connect(): Promise<void> {
		const { host, port } = this.target;
		const request = this.#current;
		const signal = request?.signal;
		const socket = new Socket().setNoDelay(true);
		socket.connect(port, host);
		const expiry = AbortSignal.timeout(this.#options.connectTimeout);
		try {
			await once(socket, 'connect', { signal: signal ? AbortSignal.any([expiry, signal]) : expiry });
		} catch (error) {
			socket.destroy();
			if (signal?.aborted) throw new CancelledError(request?.sent ?? []);
			throw new ScpiError(`Cannot connect to ${host}:${port}: ${(error as Error).message}`, { cause: error });
		}
		socket.on('data', (chunk: Buffer) => this.#receive(chunk));
		socket.on('error', (error) =>
			this.#teardown(new ScpiError(`Connection to ${host}:${port} failed: ${error.message}`)),
		);
		socket.on('close', () => this.#teardown(new ScpiError(`Connection to ${host}:${port} closed`)));
		this.#socket = socket;
		this.#current = { signal, sent: [] }; // the handshake is the connection's own traffic, not the caller's request
		try {
			await this.#options.onConnect?.(this.#session);
		} catch (error) {
			this.#teardown(new ScpiError(`Handshake with ${host}:${port} failed`));
			throw error;
		} finally {
			this.#current = request;
		}
	}

	#write(command: string, payload?: Buffer, echo = command): Promise<void> {
		if (/[\r\n]/.test(command)) {
			return Promise.reject(new ScpiError('Command must be a single line. Remove any line breaks.'));
		}
		const cancelled = this.#cancelled();
		if (cancelled) return Promise.reject(cancelled);
		const socket = this.#socket;
		if (!socket) return Promise.reject(new ScpiError('Not connected'));
		this.#current?.sent.push(echo);
		const message = payload
			? Buffer.concat([Buffer.from(`${command} `, 'latin1'), payload, Buffer.from('\n', 'ascii')])
			: `${command}\n`;
		return new Promise((resolve, reject) =>
			socket.write(message, (error) => (error ? reject(new ScpiError(error.message)) : resolve())),
		);
	}

	#cancelled(): CancelledError | undefined {
		return this.#current?.signal?.aborted ? new CancelledError(this.#current.sent) : undefined;
	}

	#within(requested: number): number {
		const ceiling = this.#options.maxResponseTimeout;
		if (requested <= ceiling) return requested;
		warn(`A response timeout of ${requested} ms was requested. The ${ceiling} ms ceiling applies instead.`);
		return ceiling;
	}

	async #exchange(command: string, read: FrameReader, requested: number): Promise<Buffer> {
		const timeout = this.#within(requested);
		if (this.#pending) throw new ScpiError('Another exchange is in progress. Retry after the current call finishes.');
		await this.#write(command);
		const signal = this.#current?.signal;
		return new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					this.#teardown(
						new ScpiError(`The instrument did not respond within ${timeout} ms. The connection was closed.`),
					),
				timeout,
			);
			const abort = () => this.#teardown(new CancelledError(this.#current?.sent ?? []));
			signal?.addEventListener('abort', abort);
			this.#pending = {
				read,
				resolve,
				reject,
				done: () => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', abort);
				},
			};
			// An abort that lands while the command is being written arrives before this listener exists.
			if (signal?.aborted) abort();
			else this.#receive();
		});
	}

	#receive(chunk?: Buffer): void {
		const pending = this.#pending;
		if (!pending) {
			if (chunk?.length) log().warn({ scpi: { discarded: chunk.byteLength } }, 'unsolicited response discarded');
			this.#discard();
			return;
		}
		const { maxResponseBytes } = this.#options;
		if (chunk) {
			// Checked before the chunk is taken in, so the cap bounds what is allocated and not only what is kept.
			if (this.#filled + chunk.length > maxResponseBytes) {
				this.#teardown(
					new ScpiError(`The instrument response exceeded ${maxResponseBytes} bytes. The connection was closed.`),
				);
				return;
			}
			this.#append(chunk);
		}
		const frame = this.#frame(pending);
		if (!frame) return;
		const payload = Buffer.copyBytesFrom(frame.payload);
		const residue = this.#filled - frame.end;
		if (residue > 0) log().warn({ scpi: { discarded: residue } }, 'trailing response bytes discarded');
		this.#discard();
		this.#pending = undefined;
		pending.done();
		pending.resolve(payload);
	}

	// A megabyte-sized waveform arrives in thousands of chunks; appending each one into a buffer that doubles when it
	// runs out keeps that linear, where concatenating pair by pair copies the whole response again per chunk.
	#append(chunk: Buffer): void {
		if (this.#filled + chunk.length > this.#buffer.length) {
			const room = Math.max(this.#filled + chunk.length, this.#buffer.length * 2, 8192);
			const grown = Buffer.allocUnsafe(Math.min(room, this.#options.maxResponseBytes));
			this.#buffer.copy(grown, 0, 0, this.#filled);
			this.#buffer = grown;
		}
		chunk.copy(this.#buffer, this.#filled);
		this.#filled += chunk.length;
	}

	#discard(): void {
		this.#buffer = Buffer.alloc(0);
		this.#filled = 0;
	}

	// A reader that rejects the response it is being handed ends the exchange instead of escaping the data event.
	#frame(pending: Pending): Frame | undefined {
		try {
			return pending.read(this.#buffer.subarray(0, this.#filled));
		} catch (error) {
			this.#teardown(error instanceof ScpiError ? error : new ScpiError(String(error)));
			return undefined;
		}
	}

	#teardown(error: ScpiError): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending) {
			pending.done();
			pending.reject(error);
		}
		this.#socket?.removeAllListeners();
		this.#socket?.destroy();
		this.#socket = undefined;
		this.#discard();
	}
}
