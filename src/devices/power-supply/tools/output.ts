import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import { asQuantity, type Quantity } from '../../../scpi/values.ts';
import { applied, compare, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { PowerSupply } from '../supply.ts';
import { mutating, readOnly, tool } from './define.ts';
import { amps, channel, decimal, output, volts } from './schema.ts';

const withWire = (row: ReturnType<typeof param>) => ({ ...row, wire: decimal });

export const source = [
	withWire(param('voltage', 'VOLTage', volts, 'Output voltage in volts', asQuantity)),
	withWire(param('current', 'CURRent', amps, 'Output current limit in amperes', asQuantity)),
];

// The sources state ratings for three models only (SPD1168X 16 V/8 A, SPD1305X 30 V/5 A, SPD3303C 32 V/3.2 A);
// a request beyond them is refused before anything is written, and a model without a documented rating is warned.
function checkRating(supply: PowerSupply, values: Values): void {
	const rating = supply.capabilities?.rating;
	const model = supply.identity?.model;
	if (!rating) {
		supply.warn(`The output rating for ${model} is unknown. Voltage and current are sent without rating validation.`);
		return;
	}
	const { voltage, current } = values as { voltage?: number; current?: number };
	if (voltage !== undefined && voltage > rating.volts)
		throw new Error(`${model} outputs up to ${rating.volts} V. Reduce voltage to ${rating.volts} V or less.`);
	if (current !== undefined && current > rating.amps)
		throw new Error(`${model} outputs up to ${rating.amps} A. Reduce current to ${rating.amps} A or less.`);
}

// A setpoint query answers a plain decimal. Anything else is reported as it arrived, with a warning, never as a zero.
function reported(supply: PowerSupply, state: Values): Values {
	for (const [name, reading] of Object.entries(state)) {
		const { value, raw } = reading as Partial<Quantity>;
		if (value === undefined) supply.warn(`The ${name} setpoint reads ${JSON.stringify(raw)}, which is not a number.`);
	}
	return state;
}

export const outputTools = [
	tool({
		name: 'measure_output',
		description:
			'Measure the voltage and current a channel is delivering right now, plus power on SPD1000X. get_output reports what the channel is set to instead. Values are plain decimals without units. The first reading taken right after an output switch can still answer the previous value, so read again after a moment when it matters.',
		input: z.object({ channel }),
		annotations: readOnly,
		handler: ({ channel }, supply) =>
			supply.execute(async (session) => {
				supply.requireDocumented();
				supply.requireChannel(channel);
				const measured: Record<string, unknown> = {
					channel,
					voltage: asQuantity(await session.query(`MEASure:VOLTage? ${channel}`)),
					current: asQuantity(await session.query(`MEASure:CURRent? ${channel}`)),
				};
				if (supply.capabilities?.features.powerMeasure !== 'unsupported')
					measured.power = asQuantity(await session.query(`MEASure:POWEr? ${channel}`));
				return measured;
			}),
	}),
	tool({
		name: 'get_output',
		description:
			'Read the configured voltage and current limit of CH1 or CH2 without changing them. This is what the channel is set to. measure_output reports what it is delivering. The fixed CH3 of the SPD3303 set is not programmable and has no setpoint.',
		input: z.object({ channel }),
		annotations: readOnly,
		handler: ({ channel }, supply) =>
			supply.execute(async (session) => {
				supply.requireDocumented();
				supply.requireChannel(channel);
				return { channel, ...reported(supply, await readback(session, source, `${channel}:`)) };
			}),
	}),
	tool({
		name: 'configure_output',
		description:
			'Set and read back the output voltage or current limit for CH1 or CH2. Optionally select 2-wire or 4-wire remote sense on SPD1000X. Wire mode has no query form. Values above the known model rating are rejected before anything is sent.',
		input: z.object({
			channel,
			...inputs(source),
			wire_mode: z.enum(['2W', '4W']).optional().describe('2-wire or 4-wire remote sense operation'),
		}),
		annotations: mutating,
		handler: (input: Values, supply) => {
			const { channel, wire_mode } = input as { channel: 'CH1' | 'CH2'; wire_mode?: '2W' | '4W' };
			const commands = plan(...settings(source, input, `${channel}:`), wire_mode && `MODE:SET ${wire_mode}`);
			return supply.execute(async (session) => {
				supply.requireDocumented();
				supply.requireChannel(channel);
				if (wire_mode) supply.require('wireMode');
				checkRating(supply, input);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(source, input), `${channel}:`);
				compare(supply, source, input, state);
				return { commands, state, ...(wire_mode && { write_only: ['MODE:SET'] }) };
			});
		},
	}),
	tool({
		name: 'set_output',
		description:
			'Turn CH1, CH2, or the fixed CH3 output on or off. CH3 is available on SPD3303 only and cannot be programmed. Optionally toggle the waveform display on SPD1000X. These settings have no query form.',
		input: z.object({
			channel: output,
			enabled: z.boolean().optional().describe('Turn the channel output on or off'),
			wave: z.boolean().optional().describe('Show or hide the waveform display for the channel'),
		}),
		annotations: mutating,
		handler: ({ channel, enabled, wave }, supply) => {
			const commands = plan(
				enabled !== undefined && `OUTPut ${channel},${onOff(enabled)}`,
				wave !== undefined && `OUTPut:WAVE ${channel},${onOff(wave)}`,
			);
			return supply.execute(async (session) => {
				supply.requireDocumented();
				supply.requireOutput(channel);
				if (wave !== undefined) supply.require('waveDisplay');
				for (const command of commands) await session.command(command);
				return { commands, write_only: commands.map((command) => command.split(' ')[0] ?? command) };
			});
		},
	}),
	tool({
		name: 'set_track_mode',
		description:
			'Select independent, series, or parallel operation for CH1 and CH2. Available on SPD3303 only. The command has no query form. get_power_status reports the active mode.',
		input: z.object({ mode: z.enum(['independent', 'series', 'parallel']).describe('How CH1 and CH2 operate') }),
		annotations: mutating,
		handler: ({ mode }, supply) => {
			const command = `OUTPut:TRACK ${['independent', 'series', 'parallel'].indexOf(mode)}`;
			return supply.execute(async (session) => {
				supply.require('track');
				await session.command(command);
				return { commands: [command], write_only: ['OUTPut:TRACK'] };
			});
		},
	}),
];
