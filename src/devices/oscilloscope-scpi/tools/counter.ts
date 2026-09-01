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
	type Values,
} from '../../../tools/params.ts';
import { type Channel, channels } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const MODE = ':COUNter:MODE';
const STATISTICS_RESET = ':COUNter:STATistics:RESet';
const TOTALIZER_RESET = ':COUNter:TOTalizer:RESet';

const modes = ['FREQuency', 'PERiod', 'TOTalizer'] as const;
const slopes = ['RISing', 'FALLing'] as const;
const gateTypes = ['LEVel', 'AEDGe'] as const;
const counting = ['FREQuency', 'PERiod'];

const MICROVOLT = 1e-6;
// The guide bounds a level by the source's volts per division and offset, with a factor that varies by model
// (4.1, 4.5 or 4.26, p. 65). This keeps a value inside what a level can mean at all and leaves the rest to the scope,
// which moves what it cannot take to the nearest value it can and comes back as a warning.
const levelVolts = z.number().min(-1e6).max(1e6);

const volts = (name: string, mnemonic: string, what: string): Param => ({
	...clamped(name, mnemonic, levelVolts, what, asQuantity, MICROVOLT),
	wire: nr3,
});

const common: Param[] = [
	flag('counter', ':COUNter', 'the counter function itself', isOn),
	param(
		'mode',
		MODE,
		z.enum(modes),
		'What the counter counts. Frequency averages over a set period. Period is its reciprocal. Totalizer is the cumulative count.',
		(raw) => asState(raw, modes),
	),
	param('source', ':COUNter:SOURce', z.enum(channels), 'the analog channel the counter counts', (raw) =>
		asState(raw, channels),
	),
	volts('level', ':COUNter:LEVel', 'the level in volts an edge is counted at'),
];

const statistics: Param[] = [
	flag('statistics', ':COUNter:STATistics', 'Counter statistics. Available in Frequency and Period modes', isOn),
];

const totalizer: Param[] = [
	flag('gate', ':COUNter:TOTalizer:GATE', 'the gate that decides when the totalizer counts', isOn),
	volts('gate_level', ':COUNter:TOTalizer:GATE:LEVel', 'the level in volts the gate opens at'),
	param(
		'gate_slope',
		':COUNter:TOTalizer:GATE:SLOPe',
		z.enum(slopes),
		'The edge that opens an Edge gate, or the polarity counted by a Level gate.',
		(raw) => asState(raw, slopes),
	),
	param(
		'gate_type',
		':COUNter:TOTalizer:GATE:TYPE',
		z.enum(gateTypes),
		'Level counts while the gate source holds the polarity named by gate_slope. Edge counts from one gate edge to the next.',
		(raw) => asState(raw, gateTypes),
	),
	param(
		'totalizer_slope',
		':COUNter:TOTalizer:SLOPe',
		z.enum(slopes),
		'the edge of the counter source the totalizer counts',
		(raw) => asState(raw, slopes),
	),
];

const params = [...common, ...statistics, ...totalizer];

export const counterTools = [
	tool({
		name: 'get_counter',
		description:
			'Read the hardware counter mode, source, level and settings relevant to the active mode. Frequency and Period include statistics settings. Totalizer includes its gate and counted-edge settings. The counted value is not available through this tool.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state = await readback(session, common);
				if (state.counter !== true) scope.warn('The counter is off, so no live count is available');
				if (state.mode === 'TOTalizer') return { ...state, ...(await readback(session, totalizer)) };
				if (counting.includes(String(state.mode))) return { ...state, ...(await readback(session, statistics)) };
				scope.warn(
					`The scope returned an unknown counter mode ${JSON.stringify(state.mode)}. Statistics and totalizer settings were not read`,
				);
				return state;
			}),
	}),
	tool({
		name: 'configure_counter',
		description:
			'Set the hardware counter and read back the requested settings. Statistics settings apply to Frequency and Period modes. Gate settings apply to Totalizer mode. Levels adjusted by the scope are returned with a warning. Counter availability cannot be determined from the model identity.',
		input: z.strictObject(inputs(params)).superRefine((input: Values, ctx) => {
			const mode = String(input.mode);
			const wrong = mode === 'TOTalizer' ? statistics : counting.includes(mode) ? totalizer : [];
			for (const { name } of wrong) {
				if (input[name] !== undefined) {
					ctx.addIssue({
						code: 'custom',
						message: `${name} is not supported in ${mode} mode. Remove it or choose a compatible mode`,
						path: [name],
					});
				}
			}
		}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				if (input.source !== undefined) scope.requireChannel(input.source as Channel);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(params, input));
				compare(scope, params, input, state, 'a level is clamped to what the source can measure');
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'reset_counter',
		description:
			'Reset the counter. Frequency and Period modes discard accumulated statistics. Totalizer mode discards the cumulative count. The reset cannot be undone and has no query form. An unknown mode sends nothing and returns a warning.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const mode = asState(await session.query(`${MODE}?`), modes);
				const command =
					mode === 'TOTalizer' ? TOTALIZER_RESET : counting.includes(String(mode)) ? STATISTICS_RESET : '';
				if (!command) {
					scope.warn(`The scope returned an unknown counter mode ${JSON.stringify(mode)}. Nothing was sent`);
					return { mode, commands: [] };
				}
				await session.command(command);
				return { mode, commands: [command] };
			}),
	}),
];
