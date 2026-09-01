import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asState, parseKeyValues, parseQuantity } from '../../../scpi/values.ts';
import {
	applied,
	compare,
	flag,
	inputs,
	pairs,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { type Channel, channels, type Scope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import { channel } from './schema.ts';

const STEP = 0.04;

const steps = (value: number): boolean => Number(value.toFixed(2)) === value && Math.round(value * 100) % 4 === 0;

const tolerance = z.number().min(STEP).max(4).refine(steps, 'tolerance in divisions, 0.04 to 4.0 in steps of 0.04');

const state = (raw: string) => asState(raw, ['ON', 'OFF'] as const);

const selection = [
	param('source', 'PFSC', channel, 'channel the mask is built around', (raw) => asState(raw, channels)),
];

const masks = [
	param('x_mask', 'XMASK', tolerance, 'tolerance in the X direction in divisions, sent in PFST'),
	param('y_mask', 'YMASK', tolerance, 'tolerance in the Y direction in divisions, sent in PFST'),
];

const alarm = [
	flag(
		'buzzer',
		'PFBF',
		'Show statistics and sound the buzzer on a failed waveform. The buzzer is independent of the general sound setting.',
		state,
	),
];

const params = [...selection, ...masks, ...alarm];

const feature = [
	flag('enabled', 'PFEN', 'enable the pass/fail test feature, which the mask, the display and a run all need', state),
];

const options = [
	flag('display', 'PFDS', 'show the failed, passed and total frame counts on screen', state),
	flag(
		'stop_on_fail',
		'PFFS',
		'Stop acquisition on the first failed frame, leaving the scope stopped with the last statistics visible. Off keeps testing and updates them.',
		state,
	),
];

const running = [flag('running', 'PFOP', 'run or stop the pass/fail test', state)];

const operation = [...feature, ...options, ...running];

const writeOnly = ['PACL', 'PFCM'];

const divisions = (value?: string): unknown =>
	value === undefined ? undefined : (parseQuantity(value)?.value ?? value);

function readTolerance(raw: string): Values {
	const fields = parseKeyValues(raw);
	return { ...Object.fromEntries(masks.map((p) => [p.name, divisions(fields[p.mnemonic])])), tolerance_raw: raw };
}

// `only` limits the read-back to what a request set; without it the whole mask is read.
const readMask = async (session: ScpiSession, only?: Values): Promise<Values> => ({
	...(await readback(session, only ? applied(selection, only) : selection)),
	...(only && !masks.some(({ name }) => only[name] !== undefined) ? {} : readTolerance(await session.query('PFST?'))),
	...(await readback(session, only ? applied(alarm, only) : alarm)),
});

function readCounts(scope: Scope, raw: string): Values {
	const fields = parseKeyValues(raw);
	const count = (key: string): number | undefined =>
		fields[key] !== undefined && Number.isFinite(Number(fields[key])) ? Number(fields[key]) : undefined;
	const [fail, pass, total] = [count('FAIL'), count('PASS'), count('TOTAL')];
	if (fail !== undefined && pass !== undefined && total !== undefined && total < fail + pass) {
		scope.warn(`The scope reports ${total} total frames for ${fail} failed and ${pass} passed.`);
	}
	return { fail, pass, total, counts_raw: raw };
}

// PG01-E02C lists PFSC, PFBF, PFEN, PFFS and PFOP as SDS1000X-E only and gives no availability table for
// PACL, PFCM, PFST, PFDS and PFDD?. A mask needs PFEN (p. 137) and the display needs it too (p. 139), so
// scope.require('xe') gates the whole subsystem rather than sending a query no other family is documented
// to answer.

export const passFailTools = [
	tool({
		name: 'get_pass_fail_mask',
		description:
			'Read the pass/fail mask source channel, X and Y tolerances in divisions, and failure alarm. Resetting statistics and creating a mask have no query form. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				return { ...(await readMask(session)), write_only: writeOnly };
			}),
	}),
	tool({
		name: 'configure_pass_fail_mask',
		description:
			'Set the pass/fail mask source, X and Y tolerances, and failure alarm. Both tolerances must be provided together. The alarm sounds the buzzer independently of the general sound setting. Creating a mask replaces the active rule, enables the test, and stops a running test. It requires `confirm_replace_mask: true`. SDS1000X-E only.',
		input: z
			.object({
				...inputs(params),
				create_mask: z.boolean().optional().describe('Build the mask from the source and tolerances.'),
				confirm_replace_mask: z
					.literal(true)
					.optional()
					.describe('Explicit acknowledgement that the active pass/fail rule is replaced and a running test stopped'),
			})
			.refine(({ x_mask, y_mask }: Values) => (x_mask === undefined) === (y_mask === undefined), {
				message: 'Provide x_mask and y_mask together.',
				path: ['y_mask'],
			})
			.refine(({ create_mask, confirm_replace_mask }) => !create_mask || confirm_replace_mask === true, {
				message: 'Creating a mask replaces the active rule. Set confirm_replace_mask to true.',
				path: ['confirm_replace_mask'],
			}),
		annotations: destructive,
		handler: (input: Values, scope) => {
			const create = input.create_mask === true;
			const encoded = pairs(masks, input);
			const commands = plan(
				...settings(selection, input),
				encoded !== '' && `PFST ${encoded}`,
				...settings(alarm, input),
				create && 'PFEN ON',
				create && 'PFOP OFF',
				create && 'PFCM',
			);
			return scope.execute(async (session) => {
				scope.require('xe');
				if (input.source !== undefined) scope.requireChannel(input.source as Channel);
				for (const command of commands) await session.command(command);
				const state = await readMask(session, input);
				compare(scope, params, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'reset_pass_fail_statistics',
		description:
			'Reset the failed, passed, and total pass/fail frame counts to zero. The command has no query form. SDS1000X-E only.',
		annotations: mutating,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				await session.command('PACL');
				return { commands: ['PACL'] };
			}),
	}),
	tool({
		name: 'get_pass_fail',
		description:
			'Read the pass/fail test state, display setting, stop-on-fail setting, and failed, passed, and total frame counts. Counts are returned exactly as reported and include the raw response. Use get_pass_fail_mask to read the mask. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				const state = await readback(session, operation);
				return { ...state, ...readCounts(scope, await session.query('PFDD?')) };
			}),
	}),
	tool({
		name: 'configure_pass_fail',
		description:
			'Enable, display, start, or stop the pass/fail test. Starting or displaying the test enables the feature when needed. Stop-on-fail stops acquisition on the first failed frame and leaves the scope stopped. The test uses the active mask, whose existence cannot be confirmed because mask creation has no query form. SDS1000X-E only.',
		input: z
			.object(inputs(operation))
			.refine(({ enabled, display, running }) => enabled !== false || !(display || running), {
				message: 'Display and running require the pass/fail feature. Remove enabled: false or enable the feature.',
				path: ['enabled'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const start = input.running === true;
			const commands = plan(
				input.running === false && 'PFOP OFF',
				...settings(feature, input),
				(start || input.display === true) && input.enabled === undefined && 'PFEN ON',
				...settings(options, input),
				start && 'PFOP ON',
			);
			return scope.execute(async (session) => {
				scope.require('xe');
				if (start) {
					scope.warn(
						'The test uses the active mask. Mask creation has no query form, so the tool cannot confirm that a mask exists.',
					);
				}
				if (input.stop_on_fail === true) {
					scope.warn('stop_on_fail: true stops acquisition on the first failed frame and leaves the scope stopped.');
				}
				for (const command of commands) await session.command(command);
				// PFEN ON goes out as a prerequisite of PFDS and PFOP, so the echo reports what this call wrote.
				const wrote = { ...input, ...(commands.includes('PFEN ON') && { enabled: true }) };
				const state = await readback(session, applied(operation, wrote));
				compare(scope, operation, input, state);
				return { commands, state };
			});
		},
	}),
];
