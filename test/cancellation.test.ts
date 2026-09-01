import type { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import type { Client } from '@modelcontextprotocol/client';
import { requestSignal } from '../src/scpi/connection.ts';
import { assertSent, payload } from './support/assertions.ts';
import type { Reply } from './support/fake-scope.ts';
import { connect, type Harness, startHarness } from './support/harness.ts';

// A 2026-07-28 client cancels by aborting its request stream, which is what reaches ctx.mcpReq.signal.
const cancelling = (url: string): Promise<Client> => connect(url, undefined, { versionNegotiation: { mode: 'auto' } });

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function withHarness(replies: Record<string, Reply>, run: (harness: Harness, client: Client) => Promise<void>) {
	const harness = await startHarness(replies);
	const client = await cancelling(harness.server.url);
	try {
		await run(harness, client);
	} finally {
		await client.close();
		await harness.close();
	}
}

// Every step waits for a condition rather than for a duration: the queued call is released only once its own
// server-side signal has aborted, so the gate cannot pass or fail on which of the two won a race.
const aborted = (signal: AbortSignal): Promise<void> =>
	signal.aborted
		? Promise.resolve()
		: new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

describe('request cancellation', () => {
	it('never sends a call that was cancelled while it waited in the queue', async () => {
		let held: Socket | undefined;
		await withHarness(
			{
				'*OPC?': (socket) => {
					held = socket;
				},
			},
			async (harness, client) => {
				const ahead = harness.client.callTool({ name: 'wait_until_complete', arguments: { timeout_ms: 120_000 } });
				await harness.fake.until('*OPC?');

				// The scope is busy from here on, so the next call to reach execute is the queued one; its signal and the
				// promise it waits on are what the assertions below synchronise with.
				const queue = Promise.withResolvers<{ signal: AbortSignal; outcome: Promise<string> }>();
				const execute = harness.scope.execute.bind(harness.scope);
				harness.scope.execute = (<T>(work: Parameters<typeof execute<T>>[0]) => {
					const running = execute(work);
					const signal = requestSignal();
					if (signal)
						queue.resolve({
							signal,
							outcome: running.then(
								() => 'ran',
								() => 'rejected',
							),
						});
					return running;
				}) as typeof harness.scope.execute;

				const controller = new AbortController();
				const queued = client.callTool(
					{ name: 'reset_scope', arguments: { confirm_reset: true } },
					{ signal: controller.signal },
				);
				const { signal, outcome } = await queue.promise;
				controller.abort();
				await expect(queued).toBeRejected();
				await aborted(signal);

				held?.write('1\n');
				expect(payload(await ahead).completed).toBe(true);
				expect(await outcome).toBe('rejected');
				assertSent(harness.fake, ['CHDR OFF', '*IDN?', '*OPC?']);
				expect(harness.fake.accepted).toBe(1);
			},
		);
	});

	it('releases the connection when *OPC? is cancelled in flight and keeps the next answer straight', {
		timeout: 10_000,
	}, async () => {
		let abandoned: Socket | undefined;
		await withHarness(
			{
				'*OPC?': (socket) => {
					abandoned = socket;
				},
				'CHDR?': 'OFF',
			},
			async (harness, client) => {
				const controller = new AbortController();
				const waiting = client.callTool(
					{ name: 'wait_until_complete', arguments: { timeout_ms: 120_000 } },
					{ signal: controller.signal },
				);
				await harness.fake.until('*OPC?');
				const next = harness.client.callTool({ name: 'get_communication_header', arguments: {} });
				await settle();
				const started = performance.now();
				controller.abort();
				await expect(waiting).toBeRejected();
				await harness.fake.until((wire) => wire.filter((line) => line === '*IDN?').length === 2);
				abandoned?.write('1\n');
				expect(payload(await next).mode).toBe('OFF');
				expect(performance.now() - started < 5_000).toBeTruthy();
				assertSent(harness.fake, ['CHDR OFF', '*IDN?', '*OPC?', 'CHDR OFF', '*IDN?', 'CHDR?']);
			},
		);
	});

	it('stops autoset before the commands that would have followed the cancelled *OPC?', async () => {
		await withHarness({ '*OPC?': undefined }, async (harness, client) => {
			const controller = new AbortController();
			const autoset = client.callTool(
				{ name: 'autoset_scope', arguments: { confirm_autoset: true } },
				{ signal: controller.signal },
			);
			await harness.fake.until('*OPC?');
			controller.abort();
			await expect(autoset).toBeRejected();
			await settle();
			expect(harness.scope.connected).toBe(false);
			assertSent(harness.fake, ['CHDR OFF', '*IDN?', 'ASET', '*OPC?']);
		});
	});
});
