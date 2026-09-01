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
import { type Harness, startHarness } from '../../../support/harness.ts';

const replies = {
	'CRMS?': 'MANUAL',
	'CRTY?': 'Y',
	'C1:CRST? VREF,VDIF,TREF,TDIF': 'VREF,2.50E+00V,VDIF,-2.50E+00V,TREF,-3.00E-06S,TDIF,2.00E-06S',
	'C1:CRST? HREF,HDIF': 'HREF,-1.00E-06S,HDIF,2.00E-06S',
	'C1:CRST? VDIF,TREF': 'C1:CRST VDIF,-5.00E-01V,TREF,-3.00E-06S',
	'C1:CRVA? HREL': 'HREL,5.00E-06S,2.00E+05Hz,-1.00E-06S,4.00E-06S',
	'C1:CRVA? VREL': 'C1:CRVA VREL,-5.00E+00V,2.50E+00V,-2.50E+00V',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

describe('cursor tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('reads mode, type and all six cursor positions', async () => {
		harness.fake.sent();
		const state = payload(await call(harness, 'get_cursors'));
		expect(state.mode).toBeEqual({ mode: 'manual', raw: 'MANUAL' });
		expect(state.type).toBeEqual({ type: 'Y', raw: 'Y' });
		const { values } = state.positions as { values: Record<string, { value: number; unit?: string; raw?: string }> };
		expect(values.VREF).toBeEqual({ value: 2.5, unit: 'V', raw: '2.50E+00V' });
		expect(values.TREF).toBeEqual({ value: -3e-6, unit: 'S', raw: '-3.00E-06S' });
		expect(values.HDIF).toBeEqual({ value: 2e-6, unit: 'S', raw: '2.00E-06S' });
		expect(state.warnings).toBe(undefined);
		assertSent(harness.fake, ['CRMS?', 'CRTY?', 'C1:CRST? VREF,VDIF,TREF,TDIF', 'C1:CRST? HREF,HDIF']);
		await assertReadOnly(harness.client, 'get_cursors');
	});

	it('batches the guide example into one CRST and reads the same cursors back', async () => {
		harness.fake.sent();
		const result = payload(
			await call(harness, 'configure_cursors', {
				mode: 'manual',
				type: 'Y',
				source: 'C1',
				positions: { TREF: '-3us', VDIF: '-500mV' },
			}),
		);
		expect(result.commands).toBeEqual(['CRMS MANUAL', 'CRTY Y', 'C1:CRST VDIF,-500mV,TREF,-3us']);
		const { positions } = result.state as { positions: { values: Record<string, { value: number }> } };
		expect(positions.values.VDIF?.value).toBe(-0.5);
		assertSent(harness.fake, [
			'CRMS MANUAL',
			'CRTY Y',
			'C1:CRST VDIF,-500mV,TREF,-3us',
			'CRMS?',
			'CRTY?',
			'C1:CRST? VDIF,TREF',
		]);
	});

	it('sends track positions and closes the cursors on an SDS1000X-E', async () => {
		harness.fake.sent();
		const track = payload(
			await call(harness, 'configure_cursors', {
				mode: 'track',
				source: 'C1',
				positions: { HREF: '-1us', HDIF: '2us' },
			}),
		);
		expect(track.commands).toBeEqual(['CRMS TRACK', 'C1:CRST HREF,-1us,HDIF,2us']);
		const off = payload(await call(harness, 'configure_cursors', { mode: 'off' }));
		expect(off.commands).toBeEqual(['CRMS OFF']);
	});

	it('parses HREL delta, frequency and both cursor times', async () => {
		const result = payload(await call(harness, 'measure_cursors', { source: 'C1', measurement: 'HREL' }));
		expect(result.delta_time).toBeEqual({ value: 5e-6, unit: 'S', raw: '5.00E-06S' });
		expect(result.frequency).toBeEqual({ value: 2e5, unit: 'Hz', raw: '2.00E+05Hz' });
		expect(result.cursor_a).toBeEqual({ value: -1e-6, unit: 'S', raw: '-1.00E-06S' });
		expect(result.cursor_b).toBeEqual({ value: 4e-6, unit: 'S', raw: '4.00E-06S' });
		await assertReadOnly(harness.client, 'measure_cursors');
	});

	it('parses the VREL guide example with a header and a delta-only reply', async () => {
		const long = payload(await call(harness, 'measure_cursors', { source: 'C1', measurement: 'VREL' }));
		expect((long.delta_voltage as { value: number }).value).toBe(-5);
		expect((long.cursor_a as { value: number }).value).toBe(2.5);
		expect((long.cursor_b as { value: number }).value).toBe(-2.5);

		harness.fake.replies.set('C1:CRVA? VREL', 'C1:CURSOR_VALUE VREL,-5.00E+00V');
		try {
			const short = payload(await call(harness, 'measure_cursors', { source: 'C1', measurement: 'VREL' }));
			expect((short.delta_voltage as { value: number }).value).toBe(-5);
			expect('cursor_a' in short).toBe(false);
		} finally {
			harness.fake.replies.set('C1:CRVA? VREL', replies['C1:CRVA? VREL']);
		}
	});

	it('rejects positions without a unit, with the wrong unit, without a source or more than four', async () => {
		await assertInvalidSendsNothing(harness, 'configure_cursors', { source: 'C1', positions: { TREF: '-3' } });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { source: 'C1', positions: { VREF: '3US' } });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { source: 'C1', positions: { TREF: '3V' } });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { positions: { TREF: '-3US' } });
		await assertInvalidSendsNothing(harness, 'configure_cursors', {
			source: 'C1',
			positions: { VREF: '1V', VDIF: '1V', TREF: '1US', TDIF: '1US', HREF: '1US' },
		});
		await assertInvalidSendsNothing(harness, 'configure_cursors', {});
	});
});

describe('cursor mode formats', () => {
	it('uses CRMS OFF|ON on an older family and refuses to close the cursors', async () => {
		const older = await startHarness({
			'*IDN?': 'Siglent Technologies,SDS1102X,SDS1EBAC0L0001,7.6.1.20',
			'CRMS?': 'OFF',
			'CRTY?': 'X',
			'C1:CRST? VREF,VDIF,TREF,TDIF': 'VREF,1.00E+00V,VDIF,-1.00E+00V,TREF,-1.00E-06S,TDIF,1.00E-06S',
			'C1:CRST? HREF,HDIF': 'HREF,-1.00E-06S,HDIF,1.00E-06S',
		});
		try {
			const state = payload(await older.client.callTool({ name: 'get_cursors', arguments: {} }));
			expect(state.mode).toBeEqual({ mode: 'manual', raw: 'OFF' });

			older.fake.sent();
			const track = payload(await older.client.callTool({ name: 'configure_cursors', arguments: { mode: 'track' } }));
			expect(track.commands).toBeEqual(['CRMS ON']);

			older.fake.sent();
			const result = await older.client.callTool({ name: 'configure_cursors', arguments: { mode: 'off' } });
			assertCapabilityError(result, 'SDS1102X');
			assertSent(older.fake, []);
		} finally {
			await older.close();
		}
	});

	it('warns that the CRMS format of an unrecognized model is unknown', async () => {
		const unknown = await startHarness({
			'*IDN?': 'Siglent Technologies,SDS9999Z,SDS1EBAC0L0001,7.6.1.20',
			'CRMS?': 'ON',
			'CRTY?': 'X',
		});
		try {
			const result = await unknown.client.callTool({ name: 'configure_cursors', arguments: { mode: 'track' } });
			assertUnknownWarning(result, 'cursor mode format');
			expect(payload(result).commands).toBeEqual(['CRMS ON']);
		} finally {
			await unknown.close();
		}
	});
});
