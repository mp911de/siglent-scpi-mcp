import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':CURSor?': 'ON',
	':CURSor:MODE?': 'MEASure',
	':CURSor:MITem?': 'PKPK,C2',
	':CURSor:TAGStyle?': 'FIXed',
	':CURSor:SOURce1?': 'C1',
	':CURSor:SOURce2?': 'C2',
	':CURSor:XREFerence?': 'DELay',
	':CURSor:YREFerence?': 'OFFSet',
	':CURSor:X1?': '-1.00E-06',
	':CURSor:X2?': '1.00E-06',
	':CURSor:Y1?': '1.20E+01',
	':CURSor:Y2?': '1.00E+01',
	':CURSor:XDELta?': '2.00E-06',
	':CURSor:IXDelta?': '5.00E+05',
	':CURSor:YDELta?': '2.00E+00',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F cursor tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads the whole cursor state and never asks for the second source outside Track mode', async () => {
		const state = payload(await call(harness, 'get_cursors'));
		expect(state).toBeEqual({
			cursors: true,
			mode: 'MEASure',
			tag_style: 'FIXed',
			source1: 'C1',
			x_reference: 'DELay',
			y_reference: 'OFFSet',
			x1: { value: -1e-6, raw: '-1.00E-06' },
			x2: { value: 1e-6, raw: '1.00E-06' },
			y1: { value: 12, raw: '1.20E+01' },
			y2: { value: 10, raw: '1.00E+01' },
			measure_item: { type: 'PKPK', source1: 'C2' },
		});
		assertSent(harness.fake, [
			':CURSor?',
			':CURSor:MODE?',
			':CURSor:TAGStyle?',
			':CURSor:SOURce1?',
			':CURSor:XREFerence?',
			':CURSor:YREFerence?',
			':CURSor:X1?',
			':CURSor:X2?',
			':CURSor:Y1?',
			':CURSor:Y2?',
			':CURSor:MITem?',
		]);
		await assertReadOnly(harness.client, 'get_cursors');
	});

	it('reads the second source in Track mode, the one mode that displays it', async () => {
		harness.fake.replies.set(':CURSor:MODE?', 'TRACk');
		try {
			const state = payload(await call(harness, 'get_cursors'));
			expect(state.source2).toBe('C2');
			expect(harness.fake.sent().includes(':CURSor:SOURce2?')).toBeTruthy();
		} finally {
			harness.fake.replies.set(':CURSor:MODE?', 'MEASure');
		}
	});

	it('splits the manual cursor type out of the mode and leaves the measure item unread', async () => {
		harness.fake.replies.set(':CURSor:MODE?', 'MANual,X');
		const state = payload(await call(harness, 'get_cursors'));
		expect(state.mode).toBe('MANual');
		expect(state.manual_type).toBe('X');
		expect(state.measure_item).toBe(undefined);
		expect(!harness.fake.sent().includes(':CURSor:MITem?')).toBeTruthy();
		harness.fake.replies.set(':CURSor:MODE?', 'MEASure');
	});

	it('sends the manual cursor type on the mode line and the positions as NR3', async () => {
		const result = payload(
			await call(harness, 'configure_cursors', {
				cursors: true,
				mode: 'MANual',
				manual_type: 'XY',
				tag_style: 'FIXed',
				source1: 'C1',
				source2: 'C2',
				x_reference: 'DELay',
				y_reference: 'OFFSet',
				x1: -1e-6,
				x2: 1e-6,
				y1: 12,
				y2: 10,
			}),
		);
		expect(result.commands).toBeEqual([
			':CURSor ON',
			':CURSor:MODE MANual,XY',
			':CURSor:TAGStyle FIXed',
			':CURSor:SOURce1 C1',
			':CURSor:SOURce2 C2',
			':CURSor:XREFerence DELay',
			':CURSor:YREFerence OFFSet',
			':CURSor:X1 -1.00E-06',
			':CURSor:X2 1.00E-06',
			':CURSor:Y1 1.20E+01',
			':CURSor:Y2 1.00E+01',
		]);
		harness.fake.sent();
	});

	it('writes the second source in every mode and skips its read-back outside Track mode', async () => {
		const result = payload(await call(harness, 'configure_cursors', { mode: 'MEASure', source2: 'C2' }));
		expect(result.commands).toBeEqual([':CURSor:MODE MEASure', ':CURSor:SOURce2 C2']);
		expect(result.state).toBeEqual({ mode: 'MEASure' });
		expect(warnings(result).some((warning) => warning.includes('source2 was written and not read back'))).toBeTruthy();
		expect(!harness.fake.sent().includes(':CURSor:SOURce2?')).toBeTruthy();
	});

	it('reads the second source back after writing it in Track mode', async () => {
		harness.fake.replies.set(':CURSor:MODE?', 'TRACk');
		try {
			const result = payload(await call(harness, 'configure_cursors', { source2: 'C2' }));
			expect(result.commands).toBeEqual([':CURSor:SOURce2 C2']);
			expect(result.state).toBeEqual({ source2: 'C2' });
			expect(result.warnings).toBe(undefined);
			assertSent(harness.fake, [':CURSor:SOURce2 C2', ':CURSor:MODE?', ':CURSor:SOURce2?']);
		} finally {
			harness.fake.replies.set(':CURSor:MODE?', 'MEASure');
		}
	});

	it('writes the measure item as one line and reads back only what it set', async () => {
		const result = payload(
			await call(harness, 'configure_cursors', {
				mode: 'MEASure',
				measure_item: { type: 'SKEW', source1: 'C1', source2: 'C2' },
			}),
		);
		expect(result.commands).toBeEqual([':CURSor:MODE MEASure', ':CURSor:MITem SKEW,C1,C2']);
		expect(result.state).toBeEqual({ mode: 'MEASure', measure_item: { type: 'PKPK', source1: 'C2' } });
		assertSent(harness.fake, [':CURSor:MODE MEASure', ':CURSor:MITem SKEW,C1,C2', ':CURSor:MODE?', ':CURSor:MITem?']);
	});

	it('warns that a source nothing can vouch for is sent as asked', async () => {
		const result = payload(await call(harness, 'configure_cursors', { source1: 'F1', source2: 'DIGital' }));
		expect(warnings(result).some((warning) => warning.includes('F1'))).toBeTruthy();
		expect(warnings(result).some((warning) => warning.includes('MSO option'))).toBeTruthy();
		harness.fake.sent();
	});

	it('reads both axes with their deltas and the state that gives them a meaning', async () => {
		const state = payload(await call(harness, 'measure_cursors'));
		expect(state).toBeEqual({
			cursors: true,
			mode: 'MEASure',
			source1: 'C1',
			horizontal: {
				cursor_a: { value: -1e-6, raw: '-1.00E-06' },
				cursor_b: { value: 1e-6, raw: '1.00E-06' },
				delta_time: { value: 2e-6, raw: '2.00E-06' },
				frequency: { value: 500000, raw: '5.00E+05' },
			},
			vertical: {
				cursor_a: { value: 12, raw: '1.20E+01' },
				cursor_b: { value: 10, raw: '1.00E+01' },
				delta_voltage: { value: 2, raw: '2.00E+00' },
			},
		});
		assertSent(harness.fake, [
			':CURSor?',
			':CURSor:MODE?',
			':CURSor:SOURce1?',
			':CURSor:X1?',
			':CURSor:X2?',
			':CURSor:XDELta?',
			':CURSor:IXDelta?',
			':CURSor:Y1?',
			':CURSor:Y2?',
			':CURSor:YDELta?',
		]);
		await assertReadOnly(harness.client, 'measure_cursors');
	});

	it('never queries a cursor position while the cursors are off', async () => {
		harness.fake.replies.set(':CURSor?', 'OFF');
		try {
			const read = payload(await call(harness, 'get_cursors'));
			expect(warnings(read).some((warning) => warning.includes('positions were not read'))).toBeTruthy();
			expect(read.x1).toBe(undefined);
			const sent = harness.fake.sent();
			expect(!sent.some((line) => /:CURSor:[XY][12]\?/.test(line))).toBeTruthy();

			const written = payload(await call(harness, 'configure_cursors', { x1: 1e-6 }));
			expect(written.commands).toBeEqual([':CURSor:X1 1.00E-06']);
			expect(warnings(written).some((warning) => warning.includes('not read back'))).toBeTruthy();
			const wrote = harness.fake.sent();
			expect(!wrote.some((line) => /:CURSor:[XY][12]\?/.test(line))).toBeTruthy();
		} finally {
			harness.fake.replies.set(':CURSor?', 'ON');
		}
	});

	it('says the cursors are off rather than reporting a measurement that is not displayed', async () => {
		harness.fake.replies.set(':CURSor?', 'OFF');
		const result = payload(await call(harness, 'measure_cursors'));
		expect(warnings(result).some((warning) => warning.includes('cursors are off'))).toBeTruthy();
		harness.fake.replies.set(':CURSor?', 'ON');
		harness.fake.sent();
	});

	it('says which pair a manual mode leaves off the display', async () => {
		harness.fake.replies.set(':CURSor:MODE?', 'MANual,X');
		const result = payload(await call(harness, 'measure_cursors'));
		expect(
			warnings(result).some((warning) => warning.includes('Only the X manual cursors are displayed')),
		).toBeTruthy();
		harness.fake.replies.set(':CURSor:MODE?', 'MEASure');
		harness.fake.sent();
	});

	it('keeps an answer that is not a number as raw text, never as 0', async () => {
		harness.fake.replies.set(':CURSor:YDELta?', '****');
		const result = payload(await call(harness, 'measure_cursors'));
		expect((result.vertical as Record<string, unknown>).delta_voltage).toBeEqual({ raw: '****' });
		expect(warnings(result).some((warning) => warning.includes('A cursor position'))).toBeTruthy();
		harness.fake.replies.set(':CURSor:YDELta?', '2.00E+00');
		harness.fake.sent();
	});

	it('sends nothing for a cursor setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_cursors', {});
		await assertInvalidSendsNothing(harness, 'configure_cursors', { manual_type: 'X' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { mode: 'TRACk', manual_type: 'X' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { mode: 'OFF' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { mode: 'TRACk', source1: 'HISTOGram' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { source1: 'D0' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { x1: '1US' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', { tag_style: 'FOLLOW' });
		await assertInvalidSendsNothing(harness, 'configure_cursors', {
			measure_item: { type: 'PKPK', source1: 'C1', source2: 'C2' },
		});
	});
});
