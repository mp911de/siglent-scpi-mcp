import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { Scope, UnsupportedError, withWarnings } from '../../../src/devices/oscilloscope/scope.ts';
import {
	assertCapabilityError,
	assertReadOnly,
	assertSent,
	assertUnknownWarning,
	payload,
} from '../../support/assertions.ts';
import { FakeScope } from '../../support/fake-scope.ts';
import { type Harness, startHarness } from '../../support/harness.ts';

async function connectedScope(model: string): Promise<[FakeScope, Scope]> {
	const fake = await FakeScope.start({ '*IDN?': `Siglent Technologies,${model},SDS1EBAC0L0001,7.6.1.20` });
	const scope = new Scope({ host: '127.0.0.1', port: fake.port }, { queryTimeout: 500 });
	await scope.execute(async () => undefined);
	return [fake, scope];
}

describe('support guard', () => {
	const cases: Array<[string, 'awg' | 'xe' | 'mso' | 'base', 'supported' | 'unsupported' | 'unknown']> = [
		['SDS1104X-E', 'base', 'supported'],
		['SDS1104X-E', 'xe', 'supported'],
		['SDS1104X-E', 'awg', 'unsupported'],
		['SDS1104X-E', 'mso', 'unsupported'],
		['SDS2104X', 'awg', 'unknown'],
		['SDS2104X', 'xe', 'unsupported'],
		['SDS1104X', 'mso', 'unknown'],
		['SDS1104X-E', 'awg', 'unsupported'],
		['SDS9999', 'base', 'unknown'],
		['SDS2104X Plus', 'base', 'unsupported'],
	];
	for (const [model, feature, support] of cases) {
		it(`${model} ${feature} is ${support}`, async () => {
			const [fake, scope] = await connectedScope(model);
			try {
				fake.sent();
				if (support === 'unsupported') {
					expect(() => scope.requireSupport(feature)).toThrowError(UnsupportedError);
					expect(() => scope.requireSupport(feature))
						.toThrowError()
						.toHaveMessageMatching(new RegExp(model));
				} else {
					const warnings: string[] = [];
					withWarnings(warnings, () => scope.requireSupport(feature));
					expect(warnings.length).toBe(support === 'unknown' ? 1 : 0);
					if (support === 'unknown')
						expect(warnings[0] ?? '').toMatchRegex(new RegExp(`${feature}.*${model}.*unknown`));
				}
				assertSent(fake, []);
			} finally {
				await scope.close();
				await fake.close();
			}
		});
	}
});

describe('structured tool errors', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0001,7.6.1.20' });
		await harness.client.callTool({ name: 'identify', arguments: {} });
	});

	after(() => harness.close());

	it('reports capability errors with kind and model without writing', async () => {
		harness.fake.sent();
		const result = await harness.client.callTool({ name: 'get_channel', arguments: { channel: 'C3' } });
		const error = assertCapabilityError(result, 'SDS1202X-E');
		expect(error.error).toMatchRegex(/2 channels/);
		assertSent(harness.fake, []);
	});

	it('reports scpi failures with kind scpi', async () => {
		const result = await harness.client.callTool({
			name: 'scpi_query',
			arguments: { command: 'NOPE?', timeout_ms: 100 },
		});
		expect(result.isError).toBe(true);
		expect(payload(result).kind).toBe('scpi');
	});

	it('keeps query tools read-only', () => assertReadOnly(harness.client, 'get_channel'));
});

describe('warning attribution', () => {
	it('gives concurrent tool calls only their own warnings', async () => {
		const harness = await startHarness({ 'DI:SW?': 'ON' });
		try {
			const [identified, configured] = await Promise.all([
				harness.client.callTool({ name: 'identify', arguments: {} }),
				harness.client.callTool({ name: 'configure_digital', arguments: { enabled: true } }),
			]);
			expect(payload(identified).model).toBe('SDS1104X-E');
			expect(payload(identified).warnings).toBe(undefined);
			assertUnknownWarning(configured, 'mso_xe');
		} finally {
			await harness.close();
		}
	});

	it('keeps the warnings of a call that continues past its transaction', async () => {
		const [fake, scope] = await connectedScope('SDS9999');
		const warnings: string[] = [];
		try {
			await withWarnings(warnings, async () => {
				await scope.execute(async () => scope.requireSupport('base'));
				await scope.execute(async () => undefined);
			});
			expect(warnings).toBeEqual(['Support for base commands on SDS9999 (unknown) is unknown']);
		} finally {
			await scope.close();
			await fake.close();
		}
	});
});
