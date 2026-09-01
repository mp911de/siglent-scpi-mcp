import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { isOn, parseKeyValues, quoted, stripHeader } from '../../../scpi/values.ts';
import { applied, compare, flag, inputs, type Param, readback, settings, type Values } from '../../../tools/params.ts';
import { type Channel, channels, counted as guarded, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import { choice } from './serial.ts';
import { filePath } from './storage.ts';

const MASK = ':MTESt';
const COUNT = ':MTESt:COUNt';
const BUZZER = ':MTESt:FUNCtion:BUZZer';
const CAPTURE = ':MTESt:FUNCtion:COF';
const HISTORY = ':MTESt:FUNCtion:FTH';
const STOP = ':MTESt:FUNCtion:SOF';
const DISPLAY = ':MTESt:IDISplay';
const CREATE = ':MTESt:MASK:CREate';
const LOAD = ':MTESt:MASK:LOAD';
const OPERATE = ':MTESt:OPERate';
const RESET = ':MTESt:RESet';
const SOURCE = ':MTESt:SOURce';
const TYPE = ':MTESt:TYPE';

const zooms = channels.map((channel) => `Z${channel.slice(1)}`);
const sources = [...channels, ...zooms] as [string, ...string[]];
const types = ['ALL_IN', 'ALL_OUT', 'ANY_IN', 'ANY_OUT'] as const;
const counts = ['FAIL', 'PASS', 'TOTAL'] as const;

// The mask margins are NR2, a decimal without an exponent, so they are written with the two decimals the range
// [0.08, 4.00] is printed to (p. 324); the guide names no unit for either.
const margin = z.number().min(0.08).max(4);
const nr2 = (value: number): string => value.toFixed(2);
const slots = z.literal([1, 2, 3, 4]);

// The mask test in the order it is sent: the function itself, then what it watches and what counts as a failure,
// then what happens on one, and the operation last, because a test that runs before it is set up tests the old mask.
const rows: Param[] = [
	flag('mask_test', MASK, 'Whether the mask test function is on', isOn),
	choice(
		'source',
		sources,
		'Waveform the mask test watches: an analog channel C1-C4 or its zoomed trace Z1-Z4. Only a zoomed source can be selected while zoom is on',
	)(SOURCE),
	choice(
		'type',
		types,
		'What the test takes as a passing frame. ALL_IN takes a waveform wholly inside the mask, ALL_OUT one wholly outside it, ANY_IN one partly inside and ANY_OUT one partly outside',
	)(TYPE),
	flag('display_results', DISPLAY, 'Whether the pass and fail counts are shown on the scope screen', isOn),
	flag('buzzer_on_fail', BUZZER, 'Whether the scope beeps when a frame fails', isOn),
	flag(
		'capture_on_fail',
		CAPTURE,
		'Whether a failing frame is saved as an image under SIGLENT/ on the scope storage. Every failure writes another file and nothing here can tell how much room is left',
		isOn,
	),
	flag('failure_to_history', HISTORY, 'Whether failing frames are kept in the history buffer', isOn),
	flag('stop_on_fail', STOP, 'Whether acquisition stops as soon as a frame fails', isOn),
	flag(
		'running',
		OPERATE,
		'Whether the mask test is running. Turning it on starts testing and off stops it. Whether starting a test discards the counts of the previous run is not documented',
		isOn,
	),
];

function gate(scope: ScpiScope, source: unknown): void {
	if (typeof source !== 'string') return;
	scope.requireChannel(`C${source.slice(1)}` as Channel);
	if (source.startsWith('Z')) scope.warn(`${source} is a zoomed source and requires zoom to be enabled`);
}

const replaced = z
	.literal(true)
	.describe('Explicit acknowledgement that the mask the scope currently holds is replaced');

export const maskTools = [
	tool({
		name: 'get_mask_test',
		description:
			'Read the mask test function, the source it watches, what it takes as a passing frame, and what it does with a failing one. Use read_mask_test_result for the pass and fail counts.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute((session) => readback(session, rows)),
	}),
	tool({
		name: 'configure_mask_test',
		description:
			'Set the mask test up and start or stop it, then read back the requested values. The test compares each acquired frame with the mask the scope currently holds, which create_mask and load_mask replace. Stop on Fail stops acquisition at the first failing frame and Capture on Fail writes an image file per failure, so both change more than the display.',
		input: z.strictObject(inputs(rows)),
		// Starting or stopping a test changes what has been counted, so repeating the same request is not a no-op.
		annotations: { ...mutating, idempotentHint: false },
		handler: (input: Values, scope) => {
			const commands = plan(...settings(rows, input));
			return scope.execute(async (session) => {
				gate(scope, input.source);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(rows, input));
				compare(scope, rows, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'read_mask_test_result',
		description:
			'Read how many frames the mask test has failed, passed and tested. The mask test function is read first and the counts are not asked for while it is off. Counts read while the test is not running are those of the last run.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const mask_test = isOn(await session.query(`${MASK}?`));
				if (!mask_test) {
					scope.warn('The mask test is off, so there is no result to read. Turn it on with configure_mask_test');
					return { mask_test };
				}
				const running = isOn(await session.query(`${OPERATE}?`));
				if (!running) scope.warn('The mask test is not running, so the counts are those of the last run');
				const raw = await session.query(`${COUNT}?`);
				const fields = parseKeyValues(raw);
				if (!counts.every((label) => label in fields)) {
					scope.warn(
						`The mask test count answered ${JSON.stringify(stripHeader(raw))} rather than FAIL, PASS and TOTAL`,
					);
					return { mask_test, running, result: { raw } };
				}
				return {
					mask_test,
					running,
					failed: guarded('the failed frame count')(fields.FAIL ?? ''),
					passed: guarded('the passed frame count')(fields.PASS ?? ''),
					total: guarded('the tested frame count')(fields.TOTAL ?? ''),
				};
			}),
	}),
	tool({
		name: 'reset_mask_test',
		description:
			'Discard the accumulated pass, fail and total counts of the mask test and start counting again. The counts are not stored anywhere else and cannot be restored. The command has no query form.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command(RESET);
				return { commands: [RESET], write_only: [RESET] };
			}),
	}),
	tool({
		name: 'create_mask',
		description:
			'Build a mask around the waveform on screen from a horizontal and a vertical margin. The current mask is replaced, and the scope does not report either margin, so the previous mask cannot be read back or restored. Requires confirm_replace_mask: true. Nothing is sent otherwise.',
		input: z.strictObject({
			x_margin: margin.describe('Horizontal margin of the mask, 0.08 to 4.00. The unit is not reported'),
			y_margin: margin.describe('Vertical margin of the mask, 0.08 to 4.00. The unit is not reported'),
			confirm_replace_mask: replaced,
		}),
		annotations: destructive,
		handler: ({ x_margin, y_margin }, scope) => {
			const commands = [`${CREATE} ${nr2(x_margin)},${nr2(y_margin)}`];
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				return { commands, write_only: [CREATE] };
			});
		},
	}),
	tool({
		name: 'load_mask',
		description:
			'Recall a mask from internal slot 1-4 or from a .msk or .smsk file on scope storage. The current mask is replaced. The scope provides no mask listing or load status, so the selected slot or file cannot be checked first and the result cannot be confirmed. Requires confirm_replace_mask: true. Nothing is sent otherwise.',
		input: z
			.strictObject({
				slot: slots.optional().describe('Internal mask slot 1 to 4'),
				file: filePath('msk', 'smsk')
					.optional()
					.describe('Mask file on scope storage, for example local/SIGLENT/TEST.msk'),
				confirm_replace_mask: replaced,
			})
			.refine(({ slot, file }) => (slot === undefined) !== (file === undefined), {
				message: 'Choose one origin: slot or file',
				path: ['slot'],
			}),
		annotations: destructive,
		handler: ({ slot, file }, scope) => {
			const commands = [slot === undefined ? `${LOAD} EXTernal,${quoted(file)}` : `${LOAD} INTernal,${slot}`];
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				return { commands, write_only: [LOAD] };
			});
		},
	}),
];
