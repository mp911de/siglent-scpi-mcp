import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import { parseFields } from '../../../scpi/values.ts';
import { mutating, tool } from './define.ts';
import { amps, decimal, dwell, volts } from './schema.ts';

const group = z.object({
	group: z.number().int().min(1).max(5).describe('Timing group 1-5'),
	voltage: volts.describe('Group output voltage in volts'),
	current: amps.describe('Group output current limit in amperes'),
	seconds: dwell.describe('Group dwell time in seconds, up to 10000'),
});

const groups = z
	.array(group)
	.min(1)
	.max(5)
	.refine((rows) => new Set(rows.map(({ group }) => group)).size === rows.length, 'Use each group number only once.')
	.optional()
	.describe('Timer groups to program');

// TIMEr:SET? answers '3, 0.5, 2': voltage, current, dwell time.
const parseGroup = (raw: string) => {
	const [voltage, current, seconds] = parseFields(raw).map(Number);
	return { voltage, current, seconds };
};

export const timerTools = [
	tool({
		name: 'configure_timer',
		description:
			'Program up to five CH1 timer groups and optionally turn the timer on or off. Available on SPD1000X only. Groups run in numerical order starting with group 1. Configured groups are read back, but the timer enable state has no query form.',
		input: z.object({
			groups,
			enabled: z.boolean().optional().describe('Turn the CH1 timer on or off'),
		}),
		annotations: mutating,
		handler: ({ groups, enabled }, supply) => {
			const commands = plan(
				...(groups ?? []).map(
					({ group, voltage, current, seconds }) =>
						`TIMEr:SET CH1,${group},${decimal(voltage)},${decimal(current)},${decimal(seconds)}`,
				),
				enabled !== undefined && `TIMEr CH1,${onOff(enabled)}`,
			);
			return supply.execute(async (session) => {
				supply.require('timer');
				if (enabled && groups && !groups.some(({ group }) => group === 1))
					supply.warn('Timer groups must start from 1. Add group 1 before enabling the timer.');
				for (const command of commands) await session.command(command);
				const state: Record<string, unknown> = {};
				for (const { group, ...wanted } of groups ?? []) {
					const raw = await session.query(`TIMEr:SET? CH1,${group}`);
					const read = parseGroup(raw);
					if (Object.values(read).some(Number.isNaN)) {
						state[`group_${group}`] = { raw };
						continue;
					}
					state[`group_${group}`] = read;
					for (const [field, value] of Object.entries(wanted)) {
						const reported = read[field as keyof typeof read] ?? Number.NaN;
						if (Math.abs(reported - value) > 1e-9)
							supply.warn(`The group ${group} ${field} was set to ${value}, but the supply reports ${reported}.`);
					}
				}
				return { commands, state, ...(enabled !== undefined && { write_only: ['TIMEr'] }) };
			});
		},
	}),
];
