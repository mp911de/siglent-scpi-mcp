import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import { asQuantity, asState, isOn } from '../../../scpi/values.ts';
import {
	applied,
	clamped,
	compare,
	flag,
	inputs,
	type Param,
	param,
	readback,
	settings,
} from '../../../tools/params.ts';
import { counted } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const references = ['DELay', 'POSition'] as const;

// The guide gives no range of its own for either: it points at the datasheet for the scale (p. 412) and bounds the
// delay by the scale in force (p. 409). These bounds keep a value inside what a time base can mean at all; the scope
// moves anything it cannot take to the nearest value it can, which the read-back turns into a warning.
const PICOSECOND = 1e-12;
const scaleValue = z.number().min(PICOSECOND).max(1_000);
const delayValue = z.number().min(-1_000).max(1_000);

const timed = (name: string, mnemonic: string, schema: z.ZodType, what: string): Param => ({
	...clamped(name, mnemonic, schema, what, asQuantity, PICOSECOND),
	wire: nr3,
});

const params: Param[] = [
	param(
		'reference',
		':TIMebase:REFerence',
		z.enum(references),
		'What stays fixed while the horizontal scale changes. Delay expands around the centre of the screen. Position expands around its grid position',
		(raw) => asState(raw, references),
	),
	param(
		'reference_position',
		':TIMebase:REFerence:POSition',
		z.number().int().min(0).max(100),
		'Horizontal reference center in percent from 0 to 100. The Delay strategy expands around this point.',
		counted('reference_position'),
	),
	timed(
		'time_per_div',
		':TIMebase:SCALe',
		scaleValue,
		'Main horizontal scale in seconds per division. The range varies by model',
	),
	timed(
		'trigger_delay',
		':TIMebase:DELay',
		delayValue,
		'Seconds between the trigger and the reference point on screen. A negative value places the trigger before it',
	),
	flag('zoom_window', ':TIMebase:WINDow', 'the zoomed window', isOn),
	timed(
		'zoom_scale',
		':TIMebase:WINDow:SCALe',
		scaleValue,
		'zoomed window scale in seconds per division, which the scope caps at the main scale',
	),
	timed(
		'zoom_position',
		':TIMebase:WINDow:DELay',
		delayValue,
		'Position of the zoomed window inside the main sweep in seconds. An unsupported position is moved to the nearest valid value',
	),
];

export const timebaseTools = [
	tool({
		name: 'get_timebase',
		description:
			'Read the horizontal reference, main scale, trigger delay and zoom window settings. Time values are returned in seconds.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute((session) => readback(session, params)),
	}),
	tool({
		name: 'configure_timebase',
		description:
			'Set the horizontal reference, main scale, trigger delay and zoom window settings, then read back the requested values. Values adjusted by the scope are returned with a warning.',
		input: z.strictObject(inputs(params)),
		annotations: mutating,
		handler: (input, scope) => {
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(params, input));
				compare(scope, params, input, state, 'the zoomed window is kept inside the main sweep');
				return { commands, state };
			});
		},
	}),
];
