import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { detectKind, selectDriver } from '../../src/devices/index.ts';
import { Scope } from '../../src/devices/oscilloscope/scope.ts';
import { Instrument } from '../../src/scpi/instrument.ts';
import { startServer } from '../../src/server.ts';
import { payload } from '../support/assertions.ts';
import { FakeScope } from '../support/fake-scope.ts';
import { awaitDisconnect, connect } from '../support/harness.ts';

describe('device kind detection', () => {
	const cases: Array<[string, string]> = [
		['SDS1104X-E', 'oscilloscope'],
		['SDS2354X HD', 'oscilloscope'],
		['SDS9999', 'oscilloscope'],
		['SPD3303X-E', 'power-supply'],
		['SAG1021I', 'unknown'],
		['', 'unknown'],
	];
	for (const [model, kind] of cases) {
		it(`${model || '(empty)'} is ${kind}`, () => {
			expect(detectKind(model)).toBe(kind);
		});
	}

	it('selects the driver matching the detected kind and falls back to unknown otherwise', () => {
		expect(selectDriver('SDS1104X-E').kind).toBe('oscilloscope');
		expect(selectDriver('SDS9999').kind).toBe('oscilloscope');
		expect(selectDriver('SPD3303X-E').kind).toBe('power-supply');
		expect(selectDriver('SPD9999').kind).toBe('power-supply');
		expect(selectDriver('SAG1021I').kind).toBe('unknown');
	});
});

describe('startup probe', () => {
	it('sends exactly *IDN? and nothing else', async () => {
		const fake = await FakeScope.start();
		const probe = new Instrument({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500 });
		try {
			await probe.execute(async () => undefined);
			expect(fake.sent()).toBeEqual(['*IDN?']);
			expect(probe.identity?.model).toBe('SDS1104X-E');
		} finally {
			await probe.close();
			await fake.close();
		}
	});
});

describe('reconnect safety', () => {
	it('retires the connection when the model changed since the probe', async () => {
		const fake = await FakeScope.start();
		const scope = new Scope({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500, expect: 'SDS1104X-E' });
		try {
			await scope.execute(async () => undefined);
			fake.replies.set('*IDN?', 'Siglent Technologies,SDS1204X-E,SDS1EBAC0L0099,7.6.1.15');
			fake.dropConnections();
			await awaitDisconnect(scope);
			expect(await expect(scope.execute(async () => undefined)).toBeRejected()).toMatch(
				(error) =>
					error instanceof Error &&
					/now identifies as SDS1204X-E, not SDS1104X-E\. Restart the server/.test(error.message),
			);
			expect(await expect(scope.execute(async () => undefined)).toBeRejected()).toMatch(
				(error) => error instanceof Error && /now identifies as SDS1204X-E/.test(error.message),
			);
			expect(scope.connected).toBe(false);
		} finally {
			await scope.close();
			await fake.close();
		}
	});
});

describe('unknown-kind driver', () => {
	it('serves identify, status and raw SCPI without scope tools or CHDR traffic', async () => {
		const fake = await FakeScope.start({
			'*IDN?': 'Siglent Technologies,SAG1021I,SAG000001,1.0',
			'FREQ?': '1000',
		});
		const driver = selectDriver('SAG1021I');
		const instrument = driver.create({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500, expect: 'SAG1021I' });
		const server = await startServer(
			{ host: '127.0.0.1', port: 0, path: '/mcp', enableDangerousCommands: true },
			driver,
			instrument,
		);
		const client = await connect(server.url);
		try {
			const { tools } = await client.listTools();
			expect(tools.map(({ name }) => name).sort()).toBeEqual(['identify', 'scpi_command', 'scpi_query', 'status']);

			const identified = payload(await client.callTool({ name: 'identify', arguments: {} }));
			expect(identified.model).toBe('SAG1021I');
			expect('capabilities' in identified).toBe(false);

			const queried = payload(await client.callTool({ name: 'scpi_query', arguments: { command: 'FREQ?' } }));
			expect(queried.response).toBe('1000');

			const status = payload(await client.callTool({ name: 'status', arguments: {} }));
			expect(status.connected).toBe(true);

			expect(fake.sent()).toBeEqual(['*IDN?', '*IDN?', 'FREQ?']);

			const health = await fetch(new URL('/healthz', server.url));
			expect(await health.json()).toBeEqual({ status: 'ok', instrument: { connected: true } });

			const refused = await client.callTool({ name: 'scpi_query', arguments: { command: 'FREQ' } });
			expect(refused.isError).toBe(true);
			expect(fake.sent()).toBeEqual([]);
		} finally {
			await client.close();
			await server.close();
			await fake.close();
		}
	});
});
