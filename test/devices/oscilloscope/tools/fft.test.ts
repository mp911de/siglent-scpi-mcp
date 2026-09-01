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
	'DEF?': "DEF EQN,'FFTC1'",
	'FFTU?': 'FFTU VRMS',
	'FFTS?': 'FFTS 1.00E-01Vrms',
	'FFTP?': 'FFTP 2.80E-02V',
	'FFTC?': 'FFTC 5.80E+07Hz',
	'FFTF?': 'FFTF ON',
	'FFTW?': 'FFTW HAMM',
	'FFTT?': 'FFTT 100.00MHz',
};

const readback = ['DEF?', 'FFTU?', 'FFTS?', 'FFTP?', 'FFTC?', 'FFTF?', 'FFTW?', 'FFTT?'];

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('fft tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads the source, both scales, the offset, the center frequency, the mode and the window', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_fft'));
		assertSent(harness.fake, readback);
		expect(state.operation).toBe('fft');
		expect(state.sources).toBeEqual(['C1']);
		expect(state.scale_unit).toBe('VRMS');
		expect(state.vertical_scale).toBeEqual({ value: 0.1, unit: 'Vrms', raw: 'FFTS 1.00E-01Vrms' });
		expect(state.vertical_position).toBeEqual({ value: 0.028, unit: 'V', raw: 'FFTP 2.80E-02V' });
		expect(state.center_frequency).toBeEqual({ value: 58_000_000, unit: 'Hz', raw: 'FFTC 5.80E+07Hz' });
		expect(state.horizontal_scale).toBeEqual({ value: 100_000_000, unit: 'Hz', raw: 'FFTT 100.00MHz' });
		expect(state.display_mode).toBe('ON');
		expect(state.window).toBe('HAMM');
		await assertReadOnly(harness.client, 'get_fft');
	});

	it('sends the scale type before the scale and the offset, and the equation before all of them', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_fft', {
				source: 'C1',
				center_frequency: '58MHz',
				display_mode: 'ON',
				vertical_position: '28mV',
				vertical_scale: 0.1,
				scale_unit: 'VRMS',
				window: 'HAMM',
			}),
		);
		const commands = ["DEF EQN,'FFTC1'", 'FFTU VRMS', 'FFTS 0.1', 'FFTP 28mV', 'FFTC 58MHz', 'FFTF ON', 'FFTW HAMM'];
		expect(result.commands).toBeEqual(commands);
		assertSent(harness.fake, [...commands, ...readback]);
		expect(result.warnings).toBe(undefined);
	});

	for (const window of ['RECT', 'BLAC', 'HANN', 'HAMM', 'FLATTOP']) {
		it(`sets the ${window} window`, async () => {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_fft', { window }));
			expect(result.commands).toBeEqual([`FFTW ${window}`]);
			assertSent(harness.fake, ['DEF?', `FFTW ${window}`, 'FFTW?']);
		});
	}

	for (const [scale_unit, scale] of [
		['VRMS', 0.001],
		['DBM', 0.1],
		['DBVRMS', 20],
	] as const) {
		it(`accepts ${scale} for the ${scale_unit} scale type`, async () => {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_fft', { scale_unit, vertical_scale: scale }));
			expect(result.commands).toBeEqual([`FFTU ${scale_unit}`, `FFTS ${scale}`]);
			assertSent(harness.fake, ['DEF?', `FFTU ${scale_unit}`, `FFTS ${scale}`, 'FFTU?', 'FFTS?']);
		});
	}

	for (const [display_mode, what] of [
		['OFF', 'split screen'],
		['ON', 'full screen'],
		['EXCLU', 'exclusive'],
	] as const) {
		it(`round-trips the ${what} display mode`, async () => {
			harness.fake.replies.set('FFTF?', `FFTF ${display_mode}`);
			try {
				harness.fake.sent();
				const result = payload(await call(harness, 'configure_fft', { display_mode }));
				expect(result.commands).toBeEqual([`FFTF ${display_mode}`]);
				expect((result.state as Record<string, unknown>).display_mode).toBe(display_mode);
			} finally {
				harness.fake.replies.set('FFTF?', replies['FFTF?']);
			}
		});
	}

	it('rejects a Vrms-only scale and the offset for a decibel scale type before any query', async () => {
		await assertInvalidSendsNothing(harness, 'configure_fft', { scale_unit: 'DBVRMS', vertical_scale: 0.01 });
		await assertInvalidSendsNothing(harness, 'configure_fft', { scale_unit: 'DBM', vertical_position: '28mV' });
	});

	it('reads the scale type the scope holds when the request does not set one', async () => {
		harness.fake.replies.set('FFTU?', 'FFTU DBM');
		try {
			for (const args of [{ vertical_scale: 0.005 }, { vertical_position: '-13.5V' }]) {
				harness.fake.sent();
				const result = await call(harness, 'configure_fft', args);
				expect(result.isError).toBe(true);
				expect(text(result)).toMatchRegex(/The current scale type is DBM/);
				assertSent(harness.fake, ['DEF?', 'FFTU?']);
			}
		} finally {
			harness.fake.replies.set('FFTU?', replies['FFTU?']);
		}
	});

	it('requires the math operation to be FFT when no source is given', async () => {
		harness.fake.replies.set('DEF?', "DEF EQN,'C1+C2'");
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_fft', { window: 'RECT' });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatchRegex(/operation is add.*Provide source/s);
			assertSent(harness.fake, ['DEF?']);
		} finally {
			harness.fake.replies.set('DEF?', replies['DEF?']);
		}
	});

	it('sends the settings unchecked with a warning when DEF? is not a guide equation', async () => {
		harness.fake.replies.set('DEF?', 'DEF EQN,C1?C2');
		try {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_fft', { window: 'BLAC' }));
			assertSent(harness.fake, ['DEF?', 'FFTW BLAC', 'FFTW?']);
			expect(
				(result.warnings as string[]).some((warning) => /math operation response.*not recognized/.test(warning)),
			).toBeTruthy();
		} finally {
			harness.fake.replies.set('DEF?', replies['DEF?']);
		}
	});

	it('warns about a center frequency the scope clamped', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_fft', { source: 'C1', center_frequency: '30MHz' }));
		expect(result.commands).toBeEqual(["DEF EQN,'FFTC1'", 'FFTC 30MHz']);
		expect(
			(result.warnings as string[]).some((warning) => warning.startsWith('center_frequency was set to "30MHz"')),
		).toBeTruthy();
	});

	it('does not call a zero offset clamped when the scope reports zero back', async () => {
		harness.fake.replies.set('FFTP?', 'FFTP 0.00E+00V');
		try {
			harness.fake.sent();
			const result = payload(await call(harness, 'configure_fft', { vertical_position: '0V' }));
			assertSent(harness.fake, ['DEF?', 'FFTU?', 'FFTP 0V', 'FFTP?']);
			expect(result.warnings).toBe(undefined);
		} finally {
			harness.fake.replies.set('FFTP?', replies['FFTP?']);
		}
	});

	it('warns about a zero offset the scope did not take', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_fft', { vertical_position: '0V' }));
		expect(
			(result.warnings as string[]).some((warning) => warning.startsWith('vertical_position was set to "0V"')),
		).toBeTruthy();
	});

	it('rejects values outside the guide sets without writing', async () => {
		await assertInvalidSendsNothing(harness, 'configure_fft', { vertical_scale: 0.3 });
		await assertInvalidSendsNothing(harness, 'configure_fft', { scale_unit: 'DBUV' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { window: 'BLACKMAN' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { display_mode: 'EXCLUSIVE' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { center_frequency: '58GHz' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { center_frequency: 'DROP TABLE' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { vertical_position: '28ms' });
		await assertInvalidSendsNothing(harness, 'configure_fft', { source: 'C5' });
	});

	it('refuses an empty configuration', async () => {
		const result = await call(harness, 'configure_fft');
		expect(result.isError).toBe(true);
		expect(text(result)).toMatchRegex(/Provide at least one setting to configure/);
	});

	it('skips the X-E only commands on the older families and refuses to send them', async () => {
		const older = await startHarness({
			...replies,
			'*IDN?': 'Siglent Technologies,SDS2304X,SDS2X0001,1.2.3',
		});
		try {
			await older.client.callTool({ name: 'identify', arguments: {} });
			older.fake.sent();
			const state = payload(await older.client.callTool({ name: 'get_fft', arguments: {} }));
			assertSent(older.fake, ['DEF?', 'FFTS?', 'FFTF?', 'FFTW?']);
			expect(state.scale_unit).toBe(undefined);
			expect(state.horizontal_scale).toBe(undefined);
			expect(state.window).toBe('HAMM');

			older.fake.sent();
			const rejected = await older.client.callTool({
				name: 'configure_fft',
				arguments: { center_frequency: '58MHz' },
			});
			assertCapabilityError(rejected, 'SDS2304X');
			assertSent(older.fake, []);

			older.fake.sent();
			const unchecked = payload(
				await older.client.callTool({ name: 'configure_fft', arguments: { vertical_scale: 5 } }),
			);
			assertSent(older.fake, ['DEF?', 'FFTS 5', 'FFTS?']);
			expect(
				(unchecked.warnings as string[]).some((warning) => /scale type cannot be read.*sent unchecked/.test(warning)),
			).toBeTruthy();
		} finally {
			await older.close();
		}
	});

	it('refuses the newer SCPI dialect', async () => {
		const newer = await startHarness({ ...replies, '*IDN?': 'Siglent Technologies,SDS2504X HD,SDS2X0001,1.2.3' });
		try {
			assertCapabilityError(await newer.client.callTool({ name: 'get_fft', arguments: {} }), 'SDS2504X HD');
			expect(newer.fake.received).toBeEqual(['CHDR OFF', '*IDN?']);
		} finally {
			await newer.close();
		}
	});
});
