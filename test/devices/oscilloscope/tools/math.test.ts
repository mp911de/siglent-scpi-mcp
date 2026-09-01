import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const replies = {
	'DEF?': "DEF EQN,'C1*C2'",
	'MATH:INVS?': 'OFF',
	'MTVD?': '500mV',
	'MTVP?': '50',
};

// The channel read-back keeps configure_channel from timing out where the two INVS commands are compared.
const channelReplies = {
	'C1:ATTN?': '10',
	'C1:VDIV?': '1V',
	'C1:OFST?': '0V',
	'C1:CPL?': 'D1M',
	'C1:SKEW?': '0S',
	'C1:UNIT?': 'V',
	'C1:INVS?': 'OFF',
	'C1:TRA?': 'ON',
	'BWL?': 'C1,OFF',
};

const readback = ['DEF?', 'MATH:INVS?', 'MTVD?', 'MTVP?'];

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const equations: Array<[string, string[], string]> = [
	['add', ['C1', 'C2'], 'C1+C2'],
	['subtract', ['C1', 'C2'], 'C1-C2'],
	['multiply', ['C1', 'C2'], 'C1*C2'],
	['divide', ['C3', 'C4'], 'C3/C4'],
	['fft', ['C1'], 'FFTC1'],
	['integrate', ['C2'], 'INTGC2'],
	['differentiate', ['C3'], 'DIFFC3'],
	['sqrt', ['C4'], 'SQRTC4'],
];

describe('math tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ ...replies, ...channelReplies });
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the equation, inversion, scale and position', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_math'));
		assertSent(harness.fake, readback);
		expect(state.operation).toBe('multiply');
		expect(state.sources).toBeEqual(['C1', 'C2']);
		expect(state.equation).toBe('C1*C2');
		expect(state.equation_raw).toBe("DEF EQN,'C1*C2'");
		expect(state.inverted).toBe(false);
		expect(state.vertical_scale).toBeEqual({ value: 0.5, unit: 'V', raw: '500mV' });
		expect(state.vertical_position).toBe(50);
		await assertReadOnly(harness.client, 'get_math');
	});

	for (const [operation, sources, equation] of equations) {
		it(`builds the guide equation for ${operation}`, async () => {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_math', { operation, sources }));
			expect(result.commands).toBeEqual([`DEF EQN,'${equation}'`]);
			assertSent(harness.fake, [`DEF EQN,'${equation}'`, 'DEF?']);
		});
	}

	it('sends the equation before inversion, scale and position and reads the state back', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_math', {
				operation: 'add',
				sources: ['C1', 'C2'],
				inverted: true,
				vertical_scale: '1V',
				vertical_position: -50,
			}),
		);
		const commands = ["DEF EQN,'C1+C2'", 'MATH:INVS ON', 'MTVD 1V', 'MTVP -50'];
		expect(result.commands).toBeEqual(commands);
		assertSent(harness.fake, [...commands, ...readback]);
		expect((result.state as Record<string, unknown>).operation).toBe('multiply');
	});

	it('reads the current operation only when a restricted setting needs it', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_math', { vertical_scale: '2V' }));
		expect(result.commands).toBeEqual(['MTVD 2V']);
		assertSent(harness.fake, ['DEF?', 'MTVD 2V', 'MTVD?']);
	});

	it('rejects inversion and scale while the scope is running a transform, without writing', async () => {
		harness.fake.replies.set('DEF?', "DEF EQN,'FFTC1'");
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_math', { inverted: true, vertical_scale: '1V' });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(
				/inverted and vertical_scale apply only to Add, Subtract, Multiply, and Divide/,
			);
			assertSent(harness.fake, ['DEF?']);
		} finally {
			harness.fake.replies.set('DEF?', replies['DEF?']);
		}
	});

	it('rejects the vertical position for FFT and accepts it for the other transforms', async () => {
		harness.fake.sent();
		const rejected = await call(harness, 'configure_math', {
			operation: 'fft',
			sources: ['C1'],
			vertical_position: 50,
		});
		expect(rejected.isError).toBe(true);
		expect(text(rejected)).toMatchRegex(/vertical_position is not available for FFT.*Use configure_fft/);
		assertSent(harness.fake, []);

		const accepted = payload(
			await call(harness, 'configure_math', { operation: 'integrate', sources: ['C1'], vertical_position: -100 }),
		);
		expect(accepted.commands).toBeEqual(["DEF EQN,'INTGC1'", 'MTVP -100']);
	});

	it('keeps math inversion distinct from channel inversion', async () => {
		harness.fake.sent();
		expect(payload(await call(harness, 'configure_math', { inverted: true })).commands).toBeEqual(['MATH:INVS ON']);
		expect(harness.fake.sent().includes('MATH:INVS ON')).toBeTruthy();

		await call(harness, 'configure_channel', { channel: 'C1', inverted: true });
		const channel = harness.fake.sent();
		expect(channel.includes('C1:INVS ON')).toBeTruthy();
		expect(!channel.includes('MATH:INVS ON')).toBeTruthy();
	});

	it('keeps a malformed equation as raw evidence and sends settings unchecked with a warning', async () => {
		harness.fake.replies.set('DEF?', 'DEF EQN,C1?C2');
		try {
			const state = payload(await call(harness, 'get_math'));
			expect(state.operation).toBe(undefined);
			expect(state.sources).toBe(undefined);
			expect(state.equation_raw).toBe('DEF EQN,C1?C2');

			harness.fake.sent();
			const result = payload(await call(harness, 'configure_math', { inverted: true }));
			expect(result.commands).toBeEqual(['MATH:INVS ON']);
			assertSent(harness.fake, ['DEF?', 'MATH:INVS ON', 'MATH:INVS?']);
			expect(
				(result.warnings as string[]).some((warning) =>
					/current math operation is unknown.*sent unchecked/.test(warning),
				),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set('DEF?', replies['DEF?']);
		}
	});

	it('rejects equations the guide does not define without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'add', sources: ['C1'] });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'fft', sources: ['C1', 'C2'] });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'add' });
		await assertInvalidSendsNothing(harness, 'configure_math', { sources: ['C1', 'C2'] });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'modulo', sources: ['C1', 'C2'] });
		await assertInvalidSendsNothing(harness, 'configure_math', { operation: 'add', sources: ['C1', 'C5'] });
	});

	it('rejects scale and position outside the guide set and range without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_math', { vertical_scale: '3V' });
		await assertInvalidSendsNothing(harness, 'configure_math', { vertical_position: 256 });
		await assertInvalidSendsNothing(harness, 'configure_math', { vertical_position: -256 });
		await assertInvalidSendsNothing(harness, 'configure_math', { vertical_position: 12.5 });
	});

	it('refuses an empty configuration', async () => {
		const result = await call(harness, 'configure_math');
		expect(result.isError).toBe(true);
		expect(text(result)).toMatchRegex(/Provide at least one setting to configure/);
	});

	it('refuses a source the model does not have and the newer SCPI dialect', async () => {
		const two = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS1202X-E,SDS1EBAC0L0001,7.6.1.20' });
		try {
			const result = await two.client.callTool({
				name: 'configure_math',
				arguments: { operation: 'add', sources: ['C1', 'C3'] },
			});
			assertCapabilityError(result, 'SDS1202X-E');
			expect(two.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await two.close();
		}

		const newer = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2504X HD,SDS2X0001,1.2.3' });
		try {
			assertCapabilityError(await newer.client.callTool({ name: 'get_math', arguments: {} }), 'SDS2504X HD');
			expect(newer.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await newer.close();
		}
	});
});
