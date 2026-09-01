import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { asQuantity } from '../../../scpi/values.ts';
import { applied, compare, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import { mutating, tool } from './define.ts';
import { amps, decimal, volts } from './schema.ts';

// OVP/OCP thresholds are global, not channel-prefixed, and their limits are undocumented; only the generic
// schema bounds apply, not the output rating (a protection value at or above the rating is legitimate).
const protection = [
	{ ...param('over_voltage', 'OVP', volts, 'Over-voltage protection threshold in volts', asQuantity), wire: decimal },
	{ ...param('over_current', 'OCP', amps, 'Over-current protection threshold in amperes', asQuantity), wire: decimal },
];

export const protectionTools = [
	tool({
		name: 'configure_protection',
		description:
			'Set and read back the over-voltage and over-current protection thresholds. Values are plain decimals. Available on SPD1000X only.',
		input: z.object(inputs(protection)),
		annotations: mutating,
		handler: (input: Values, supply) => {
			const commands = plan(...settings(protection, input));
			return supply.execute(async (session) => {
				supply.require('ovpOcp');
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(protection, input));
				compare(supply, protection, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'clear_protection',
		description:
			'Clear the over-voltage or over-current protection pop-up. Available on SPD1000X only. The command has no query form.',
		annotations: mutating,
		handler: (_, supply) =>
			supply.execute(async (session) => {
				supply.require('ovpOcp');
				await session.command('OUTPut:RESEt:PROTect');
				return { commands: ['OUTPut:RESEt:PROTect'], write_only: ['OUTPut:RESEt:PROTect'] };
			}),
	}),
];
