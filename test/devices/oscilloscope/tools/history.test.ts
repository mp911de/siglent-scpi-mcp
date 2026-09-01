import type { Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	assertUnknownWarning,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const textTimestamp = 'FTIM 00: 05: 12. 650814';
const parsedTimestamp = { format: 'text', hour: 0, minute: 5, second: 12, microsecond: 650814, raw: textTimestamp };
const binaryTimestamp = Buffer.from([0xff, 0x0f, 0x03, 0x01, 0x26, 0xd5, 0x02, 0x00]);

const sequence = (...answers: string[]) => {
	let index = 0;
	return (socket: Socket) => void socket.write(`${answers[Math.min(index++, answers.length - 1)]}\n`);
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

type Result = Parameters<typeof payload>[0];

const warnings = (result: Result) => (payload(result).warnings ?? []) as string[];

async function connect(replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('history tools on SDS1000X-E', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HSMD?': 'ON', 'FRAM?': '50', 'HSLST?': 'OFF', 'FTIM?': textTimestamp });
	});

	after(() => harness.close());

	it('reads history mode, the current frame, the list and the frame timestamp', async () => {
		const result = await call(harness, 'get_history');
		expect(payload(result)).toBeEqual({
			enabled: 'ON',
			frame: { value: 50, raw: '50' },
			list: 'OFF',
			timestamp: parsedTimestamp,
		});
		assertSent(harness.fake, ['HSMD?', 'FRAM?', 'HSLST?', 'FTIM?']);
		await assertReadOnly(harness.client, 'get_history');
	});

	it('keeps an unparsable timestamp raw', async () => {
		harness.fake.replies.set('FTIM?', 'FTIM ????');
		try {
			expect(payload(await call(harness, 'get_history')).timestamp).toBeEqual({ format: 'text', raw: 'FTIM ????' });
		} finally {
			harness.fake.replies.set('FTIM?', textTimestamp);
			harness.fake.sent();
		}
	});

	it('sends nothing for a request the schema rejects', async () => {
		await assertInvalidSendsNothing(harness, 'configure_history', {});
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: false, frame: 3 });
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: false, list: true });
		await assertInvalidSendsNothing(harness, 'configure_history', { frame: -1 });
		await assertInvalidSendsNothing(harness, 'configure_history', { frame: 1.5 });
		await assertInvalidSendsNothing(harness, 'configure_history', { enabled: 'ON' });
		await assertInvalidSendsNothing(harness, 'get_history', { timeout_ms: 10 });
	});

	it('reports a frame the scope clamped, without reading the range while history is already on', async () => {
		const result = await call(harness, 'configure_history', { frame: 900 });
		const applied = payload(result);
		expect(applied.commands).toBeEqual(['FRAM 900']);
		expect(applied.frame_on_enable).toBe(undefined);
		assertSent(harness.fake, ['HSMD?', 'FRAM 900', 'FRAM?']);
		expect(
			warnings(result).some((warning) => /frame was set to 900 but the scope reports 50/.test(warning)),
		).toBeTruthy();
	});

	it('is annotated as mutating', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'configure_history')?.annotations;
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(false);
	});
});

describe('history tools with history mode off', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HSMD?': 'OFF', 'HSLST?': 'ON' });
	});

	after(() => harness.close());

	it('refuses to select a frame or the list unless history is turned on in the same request', async () => {
		const result = await call(harness, 'configure_history', { frame: 3 });
		expect(assertCapabilityError(result, 'SDS1104X-E').error).toMatchRegex(/History mode is off/);
		assertSent(harness.fake, ['HSMD?']);
	});

	it('turns history on first, reads the frame range, then selects the frame and the list', async () => {
		harness.fake.replies.set('HSMD?', sequence('OFF', 'ON'));
		harness.fake.replies.set('FRAM?', sequence('120', '50'));
		try {
			const result = await call(harness, 'configure_history', { enabled: true, frame: 50, list: true });
			const applied = payload(result);
			expect(applied.commands).toBeEqual(['HSMD ON', 'FRAM 50', 'HSLST ON']);
			expect(applied.frame_on_enable).toBeEqual({ value: 120, raw: '120' });
			expect(applied.state).toBeEqual({ enabled: 'ON', frame: { value: 50, raw: '50' }, list: 'ON' });
			assertSent(harness.fake, ['HSMD?', 'HSMD ON', 'FRAM?', 'FRAM 50', 'HSLST ON', 'HSMD?', 'FRAM?', 'HSLST?']);
			expect(warnings(result)).toBeEqual([]);
		} finally {
			harness.fake.replies.set('HSMD?', 'OFF');
			harness.fake.replies.delete('FRAM?');
		}
	});
});

describe('history tools with a frame beyond what FRAM? answered', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HSMD?': 'OFF', 'FRAM?': '9', 'HSLST?': 'OFF' });
	});

	after(() => harness.close());

	it('still sends the frame and warns, because FRAM? is the max only on the first enable', async () => {
		const result = await call(harness, 'configure_history', { enabled: true, frame: 50 });
		expect(result.isError).toBe(undefined);
		expect(payload(result).frame_on_enable).toBeEqual({ value: 9, raw: '9' });
		assertSent(harness.fake, ['HSMD?', 'HSMD ON', 'FRAM?', 'FRAM 50', 'HSMD?', 'FRAM?']);
		expect(
			warnings(result).some((warning) => /Frame 50 may be outside the available history range/.test(warning)),
		).toBeTruthy();
	});
});

describe('history tools on SDS2000X', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'FTIM?': binaryTimestamp }, 'SDS2102X');
	});

	after(() => harness.close());

	it('reads only the frame timestamp, on the binary path', async () => {
		const result = await call(harness, 'get_history');
		const state = payload(result);
		expect(state.timestamp).toBeEqual({ format: 'binary', length: 8, hex: 'ff0f030126d50200' });
		expect(Object.keys(state)).toBeEqual(['timestamp', 'warnings']);
		assertSent(harness.fake, ['FTIM?']);
		expect(warnings(result).some((warning) => /supports only reading the frame timestamp/.test(warning))).toBeTruthy();
		expect(
			warnings(result).some((warning) => /unknown 8-byte timestamp.*undecoded as hexadecimal/.test(warning)),
		).toBeTruthy();
	});

	it('never treats the binary timestamp as line text', async () => {
		harness.fake.replies.set('FTIM?', Buffer.from([0xff, 0x0a, 0x03, 0xa0, 0x26, 0x0d, 0x02, 0x00]));
		try {
			const timestamp = payload(await call(harness, 'get_history')).timestamp;
			expect(timestamp).toBeEqual({ format: 'binary', length: 8, hex: 'ff0a03a0260d0200' });
		} finally {
			harness.fake.replies.set('FTIM?', binaryTimestamp);
			harness.fake.sent();
		}
	});

	it('keeps and reports more bytes than the guide example shows', async () => {
		harness.fake.replies.set('FTIM?', Buffer.from([0xff, 0x0f, 0x03, 0x01, 0x26, 0xd5, 0x02, 0x00, 0xaa, 0xbb]));
		try {
			const result = await call(harness, 'get_history');
			expect(payload(result).timestamp).toBeEqual({ format: 'binary', length: 10, hex: 'ff0f030126d50200aabb' });
			expect(
				warnings(result).some((warning) => /unknown 10-byte timestamp.*undecoded as hexadecimal/.test(warning)),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set('FTIM?', binaryTimestamp);
			harness.fake.sent();
		}
	});

	it('sends the frame command without the queries the family does not have', async () => {
		const result = await call(harness, 'configure_history', { frame: 5 });
		const applied = payload(result);
		expect(applied.commands).toBeEqual(['FRAM 5']);
		expect(applied.state).toBe(undefined);
		assertSent(harness.fake, ['FRAM 5']);
		expect(
			warnings(result).some((warning) => /cannot verify history mode or frame selection.*sent unchecked/.test(warning)),
		).toBeTruthy();
	});

	it('refuses history mode and the history list', async () => {
		assertCapabilityError(await call(harness, 'configure_history', { enabled: true }), 'SDS2102X');
		assertCapabilityError(await call(harness, 'configure_history', { list: true }), 'SDS2102X');
		assertSent(harness.fake, []);
	});
});

describe('history tools on an unsupported model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HSMD?': 'ON', 'FRAM?': '0', 'HSLST?': 'OFF', 'FTIM?': textTimestamp }, 'SDS9999Z');
	});

	after(() => harness.close());

	it('reports unknown support and still says what it read', async () => {
		const result = await call(harness, 'get_history');
		expect(payload(result).timestamp).toBeEqual(parsedTimestamp);
		assertSent(harness.fake, ['HSMD?', 'FRAM?', 'HSLST?', 'FTIM?']);
		assertUnknownWarning(result, 'xe');
		expect(warnings(result).some((warning) => /unknown timestamp format.*read as bytes/.test(warning))).toBeTruthy();
	});
});

describe('history tools on an unsupported model answering the binary timestamp', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'HSMD?': 'ON', 'FRAM?': '0', 'HSLST?': 'OFF', 'FTIM?': binaryTimestamp }, 'SDS9999Z');
	});

	after(() => harness.close());

	it('reads it as bytes instead of waiting for a line feed that never comes', async () => {
		const result = await call(harness, 'get_history', { timeout_ms: 200 });
		expect(result.isError).toBe(undefined);
		expect(payload(result).timestamp).toBeEqual({ format: 'binary', length: 8, hex: 'ff0f030126d50200' });
		assertSent(harness.fake, ['HSMD?', 'FRAM?', 'HSLST?', 'FTIM?']);
	});
});

describe('history tools with a truncated binary timestamp', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'FTIM?': Buffer.from([0xff, 0x0f, 0x03, 0x01]) }, 'SDS2102X');
	});

	after(() => harness.close());

	it('times out instead of returning a partial frame', async () => {
		const result = await call(harness, 'get_history', { timeout_ms: 100 });
		expect(result.isError).toBe(true);
		const error = payload(result);
		expect(error.kind).toBe('scpi');
		expect(String(error.error)).toMatchRegex(/instrument did not respond within 100 ms.*connection was closed/i);
	});
});
