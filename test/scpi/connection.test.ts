import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	CancelledError,
	parseTarget,
	ScpiConnection,
	ScpiError,
	withCancellation,
	withWarnings,
} from '../../src/scpi/connection.ts';
import { FakeScope, identity } from '../support/fake-scope.ts';

describe('parseTarget', () => {
	it('accepts host, host:port and bracketed IPv6', () => {
		expect(parseTarget('scope.local')).toBeEqual({ host: 'scope.local', port: 5025 });
		expect(parseTarget('192.168.1.50:5024')).toBeEqual({ host: '192.168.1.50', port: 5024 });
		expect(parseTarget('[fe80::1]:5025')).toBeEqual({ host: 'fe80::1', port: 5025 });
	});

	it('rejects anything but an address', () => {
		for (const bad of ['', 'scope.local:99999', 'scope.local/path', 'user@scope.local', 'a b']) {
			expect(() => parseTarget(bad))
				.toThrowError()
				.toHaveMessageMatching(/Invalid instrument address/);
		}
	});
});

describe('ScpiConnection', () => {
	let fake: FakeScope;

	before(async () => {
		fake = await FakeScope.start({ 'C1:VDIV?': '1.00E+00', 'SLOW?': undefined });
	});

	after(() => fake.close());

	it('refuses a response larger than the cap and drops the connection', async () => {
		const flood = await FakeScope.start({ 'BIG?': `${'x'.repeat(64 * 1024)}\n` });
		const connection = new ScpiConnection({ host: '127.0.0.1', port: flood.port }, { maxResponseBytes: 1024 });
		try {
			expect(await expect(connection.execute((session) => session.query('BIG?'))).toBeRejected()).toMatch(
				(error) => error instanceof Error && /response exceeded 1024 bytes.*connection was closed/i.test(error.message),
			);
			expect(connection.connected).toBe(false);
		} finally {
			await connection.close();
			await flood.close();
		}
	});

	it('connects lazily and runs the connect hook first', async () => {
		const seen: string[] = [];
		const connection = new ScpiConnection(
			{ host: '127.0.0.1', port: fake.port },
			{ onConnect: (session) => session.command('CHDR OFF') },
			(exchange, run) => {
				seen.push(exchange.command);
				return run();
			},
		);
		expect(connection.connected).toBe(false);
		expect(await connection.execute((session) => session.query('*IDN?'))).toBe(identity);
		expect(seen).toBeEqual(['CHDR OFF', '*IDN?']);
		await connection.close();
		expect(connection.connected).toBe(false);
	});

	it('serializes concurrent transactions', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		const first = connection.execute(async (session) => {
			await session.command('FIRST');
			await session.query('C1:VDIV?');
			await session.command('FIRST DONE');
		});
		const second = connection.execute(async (session) => {
			await session.command('SECOND');
			await session.query('C1:VDIV?');
		});
		await Promise.all([first, second]);
		const commands = fake.received.filter((line) => /FIRST|SECOND/.test(line));
		expect(commands).toBeEqual(['FIRST', 'FIRST DONE', 'SECOND']);
		await connection.close();
	});

	it('drops the connection on timeout and reconnects for the next transaction', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 50 });
		expect(await expect(connection.execute((session) => session.query('SLOW?'))).toBeRejected()).toMatch(
			(error: unknown) =>
				error instanceof ScpiError && /did not respond within 50 ms.*connection was closed/i.test(error.message),
		);
		expect(connection.connected).toBe(false);
		expect(await connection.execute((session) => session.query('C1:VDIV?'))).toBe('1.00E+00');
		expect(connection.connected).toBe(true);
		await connection.close();
	});

	it('discards an unsolicited response instead of answering the next query with it', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		await connection.execute((session) => session.command('C1:VDIV?'));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await connection.execute((session) => session.query('*IDN?'))).toBe(identity);
		await connection.close();
	});

	it('drops the socket when the connect hook fails so the next transaction retries it', async () => {
		let attempts = 0;
		const connection = new ScpiConnection(
			{ host: '127.0.0.1', port: fake.port },
			{
				onConnect: async (session) => {
					attempts += 1;
					if (attempts === 1) throw new ScpiError('bad identification');
					await session.query('*IDN?');
				},
			},
		);
		expect(await expect(connection.execute(async () => undefined)).toBeRejected()).toBeInstanceOf(ScpiError);
		expect(connection.connected).toBe(false);
		await connection.execute(async () => undefined);
		expect(attempts).toBe(2);
		await connection.close();
	});

	it('never starts a transaction cancelled while it waited in the queue', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		const controller = new AbortController();
		const running = connection.execute(async (session) => {
			controller.abort();
			await session.command('AHEAD');
		});
		const queued = withCancellation(controller.signal, () =>
			connection.execute((session) => session.command('CANCELLED')),
		);
		await running;
		expect(await expect(queued).toBeRejected()).toMatch(
			(error: unknown) => error instanceof CancelledError && error.sent.length === 0,
		);
		expect(!fake.received.includes('CANCELLED')).toBeTruthy();
		await connection.close();
	});

	it('stops a running sequence before the next command and reports what was sent', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		const controller = new AbortController();
		expect(
			await expect(
				withCancellation(controller.signal, () =>
					connection.execute(async (session) => {
						await session.command('STEP ONE');
						await fake.until('STEP ONE');
						controller.abort();
						await session.command('STEP TWO');
					}),
				),
			).toBeRejected(),
		).toMatch((error: unknown) => error instanceof CancelledError && error.sent.join() === 'STEP ONE');
		expect(fake.received.includes('STEP ONE')).toBeTruthy();
		expect(!fake.received.includes('STEP TWO')).toBeTruthy();
		await connection.close();
	});

	it('drops the socket when a query is cancelled in flight', async () => {
		fake.sent();
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 10_000 });
		const controller = new AbortController();
		const query = withCancellation(controller.signal, () => connection.execute((session) => session.query('SLOW?')));
		await fake.until('SLOW?');
		controller.abort();
		expect(await expect(query).toBeRejected()).toBeInstanceOf(CancelledError);
		expect(connection.connected).toBe(false);
		expect(await connection.execute((session) => session.query('C1:VDIV?'))).toBe('1.00E+00');
		await connection.close();
	});

	it('reports a query aborted while its command was still being written as cancelled', async () => {
		fake.sent();
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 200 });
		const controller = new AbortController();
		expect(
			await expect(
				withCancellation(controller.signal, () =>
					connection.execute((session) => {
						const answer = session.query('SLOW?');
						controller.abort(); // lands before the socket write completes, so before the abort listener exists
						return answer;
					}),
				),
			).toBeRejected(),
		).toMatch((error: unknown) => error instanceof CancelledError && error.sent.join() === 'SLOW?');
		expect(connection.connected).toBe(false);
		await connection.close();
	});

	it('gives up a connect attempt that is cancelled instead of holding the queue for the connect timeout', async () => {
		const connection = new ScpiConnection({ host: '192.0.2.1', port: 5025 }, { connectTimeout: 30_000 });
		const controller = new AbortController();
		const started = performance.now();
		const pending = withCancellation(controller.signal, () =>
			connection.execute((session) => session.command('NEVER SENT')),
		);
		setTimeout(() => controller.abort(), 20);
		expect(await expect(pending).toBeRejected()).toMatch(
			(error: unknown) => error instanceof CancelledError && error.sent.length === 0,
		);
		expect(performance.now() - started < 5_000).toBeTruthy();
		await connection.close();
	});

	it('runs a full queue and refuses the arrival that would overflow it', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		const release = Promise.withResolvers<void>();
		const numbers = Array.from({ length: 31 }, (_, index) => index + 1);
		const queued = [
			connection.execute(async (session) => {
				await release.promise;
				await session.command('HEAD');
			}),
			...numbers.map((n) => connection.execute((session) => session.command(`QUEUED ${n}`))),
		];
		expect(await expect(connection.execute((session) => session.command('OVERFLOW'))).toBeRejected()).toMatch(
			(error) => error instanceof Error && /32 requests queued/.test(error.message),
		);
		release.resolve();
		await Promise.all(queued);
		await fake.until('QUEUED 31');
		expect(fake.received.filter((line) => /HEAD|QUEUED|OVERFLOW/.test(line))).toBeEqual([
			'HEAD',
			...numbers.map((n) => `QUEUED ${n}`),
		]);
		await connection.close();
	});

	it('frees a queue slot after success, failure and cancellation', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { maxQueueDepth: 2 });
		const controller = new AbortController();
		controller.abort();
		for (let round = 0; round < 4; round += 1) {
			await connection.execute((session) => session.command('FINE'));
			await expect(
				connection.execute(async () => {
					throw new ScpiError('boom');
				}),
			).toBeRejected();
			expect(
				await expect(
					withCancellation(controller.signal, () => connection.execute((session) => session.command('NEVER'))),
				).toBeRejected(),
			).toBeInstanceOf(CancelledError);
		}
		await Promise.all([
			connection.execute((session) => session.command('DRAINED')),
			connection.execute((session) => session.command('DRAINED')),
		]);
		await connection.close();
	});

	it('clamps an exchange to the response timeout ceiling and says it did', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { maxResponseTimeout: 50 });
		const warnings: string[] = [];
		const started = performance.now();
		expect(
			await expect(
				withWarnings(warnings, () => connection.execute((session) => session.query('SLOW?', 30_000))),
			).toBeRejected(),
		).toMatch((error) => error instanceof Error && /did not respond within 50 ms/.test(error.message));
		expect(performance.now() - started < 5_000).toBeTruthy();
		expect(warnings).toBeEqual(['A response timeout of 30000 ms was requested. The 50 ms ceiling applies instead.']);
		await connection.close();
	});

	it('leaves a request below the ceiling alone', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port }, { maxResponseTimeout: 50_000 });
		const warnings: string[] = [];
		expect(
			await expect(
				withWarnings(warnings, () => connection.execute((session) => session.query('SLOW?', 40))),
			).toBeRejected(),
		).toMatch((error) => error instanceof Error && /did not respond within 40 ms/.test(error.message));
		expect(warnings).toBeEqual([]);
		await connection.close();
	});

	it('refuses multi-line commands before writing', async () => {
		const connection = new ScpiConnection({ host: '127.0.0.1', port: fake.port });
		expect(await expect(connection.execute((session) => session.command('*RST\n*RST'))).toBeRejected()).toBeInstanceOf(
			ScpiError,
		);
		expect(!fake.received.includes('*RST')).toBeTruthy();
		await connection.close();
	});
});
