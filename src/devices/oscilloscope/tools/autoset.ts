import * as z from 'zod';
import { stripHeader } from '../../../scpi/values.ts';
import { channels } from '../scope.ts';
import { readAcquisition } from './acquisition.ts';
import { readChannel } from './channel.ts';
import { destructive, tool } from './define.ts';
import { timeoutMs } from './schema.ts';
import { waitUntilComplete } from './system.ts';

export const autosetTools = [
	tool({
		name: 'autoset_scope',
		description:
			'Automatically adjust the vertical scale, timebase, and trigger to display the input signals. Waits for completion and returns the acquisition state and every visible channel. Requires `confirm_autoset: true`. Nothing is sent otherwise.',
		input: z.object({
			confirm_autoset: z
				.literal(true)
				.describe('Explicit acknowledgement that channel, timebase and trigger settings change'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 15000'),
		}),
		annotations: destructive,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				await session.command('ASET');
				const completed = await waitUntilComplete(session, timeout_ms ?? 15_000);
				const visible: Awaited<ReturnType<typeof readChannel>>[] = [];
				for (const ch of channels.slice(0, scope.capabilities?.channels ?? channels.length)) {
					if (stripHeader(await session.query(`${ch}:TRA?`)) === 'ON') visible.push(await readChannel(session, ch));
				}
				return { commands: ['ASET'], completed, acquisition: await readAcquisition(session), channels: visible };
			}),
	}),
];
