import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { asState, isOn } from '../../../scpi/values.ts';
import { applied, compare, flag, inputs, type Param, param, readback, settings } from '../../../tools/params.ts';
import { type Channel, channels, reading } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const CURRENT = ':DVM:CURRent';

const modes = ['DCavg', 'DCRMs', 'ACRMs', 'PKPK', 'AMPLitude'] as const;

const params: Param[] = [
	flag('dvm', ':DVM', 'the digital voltmeter itself', isOn),
	param('source', ':DVM:SOURce', z.enum(channels), 'the analog channel the DVM measures', (raw) =>
		asState(raw, channels),
	),
	param(
		'mode',
		':DVM:MODE',
		z.enum(modes),
		'What the digital voltmeter displays. Choose DC average, DC RMS, AC RMS, peak-to-peak, or amplitude.',
		(raw) => asState(raw, modes),
	),
	flag('auto_range', ':DVM:ARANge', 'following the signal with the vertical range automatically', isOn),
	flag('alarm', ':DVM:ALARm', 'the overload alarm, which sounds when the amplitude leaves the screen', isOn),
	flag('hold', ':DVM:HOLD', 'freezing the displayed value, which then stops following the signal', isOn),
];

export const dvmTools = [
	tool({
		name: 'get_dvm_reading',
		description:
			'Read the digital voltmeter settings and displayed value. When the voltmeter is off, no value is read and a warning is returned. Hold returns the frozen value with a warning. A nonnumeric result is preserved as raw text. Digital voltmeter availability cannot be determined from the model identity.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state = await readback(session, params);
				if (state.dvm !== true) {
					scope.warn('The digital voltmeter is off. Turn it on with configure_dvm and read again');
					return state;
				}
				if (state.hold === true) scope.warn('Hold is on, so the returned value is frozen rather than a fresh reading');
				const raw = await session.query(`${CURRENT}?`);
				return {
					...state,
					value: reading(
						scope,
						'The displayed value',
						raw,
						'A digital voltmeter with no signal may return a placeholder',
					),
				};
			}),
	}),
	tool({
		name: 'configure_dvm',
		description:
			'Set the digital voltmeter and read back the requested settings. The source must be an available analog channel C1-C4. Values rejected by the scope are returned with a warning. Digital voltmeter availability cannot be determined from the model identity.',
		input: z.strictObject(inputs(params)),
		annotations: mutating,
		handler: (input, scope) => {
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				if (input.source !== undefined) scope.requireChannel(input.source as Channel);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(params, input));
				compare(scope, params, input, state);
				return { commands, state };
			});
		},
	}),
];
