import * as z from 'zod';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { singleLine, timeoutMs } from '../../../tools/schema.ts';
import { destructive, readOnly, tool } from './define.ts';

export async function waitUntilComplete(session: ScpiSession, timeout?: number) {
	const raw = await session.query('*OPC?', timeout);
	if (raw.trim() !== '1') throw new ScpiError(`The scope did not report completion. Response: ${JSON.stringify(raw)}`);
	return { completed: true, raw };
}

export const commonTools = [
	tool({
		name: 'identify',
		description:
			'Identify the connected oscilloscope. Returns the manufacturer, model, serial number, firmware, device family and channel count.',
		annotations: readOnly,
		handler: async (_, scope) => {
			const identity = await scope.execute((session) => scope.identify(session));
			return { ...identity, capabilities: scope.capabilities, target: scope.target };
		},
	}),
	tool({
		name: 'wait_until_complete',
		description:
			'Wait until all pending scope operations have finished. Blocks the connection until the scope answers or the timeout expires. A timeout closes the connection.',
		input: z.object({ timeout_ms: timeoutMs }),
		annotations: readOnly,
		handler: ({ timeout_ms }, scope) => scope.execute((session) => waitUntilComplete(session, timeout_ms)),
	}),
	tool({
		name: 'reset_scope',
		description:
			'Reset the scope to factory defaults, wait for completion and identify it again. Requires confirm_reset: true. Nothing is sent otherwise.',
		input: z.object({
			confirm_reset: z.literal(true).describe('Explicit acknowledgement that all scope settings are discarded'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
		}),
		annotations: destructive,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				await session.command('*RST');
				const reset = await waitUntilComplete(session, timeout_ms ?? 30_000);
				const identity = await scope.identify(session);
				return { commands: ['*RST'], reset, identity, capabilities: scope.capabilities };
			}),
	}),
	tool({
		name: 'scpi_query',
		description:
			'Send a raw SCPI query and return its text response. Use this for operations without a typed tool. A query that does not answer before the timeout closes the connection.',
		input: z.object({
			command: singleLine
				.regex(/\?/, 'A SCPI query must contain ?.')
				.describe("SCPI query, for example ':CHANnel1:SCALe?'"),
			timeout_ms: timeoutMs,
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command, timeout_ms }, scope) =>
			scope.execute(async (session) => ({ commands: [command], response: await session.query(command, timeout_ms) })),
	}),
	tool({
		name: 'scpi_command',
		description: 'Send a raw SCPI command without reading a response. Escape hatch for commands without a typed tool.',
		input: z.object({
			command: singleLine
				.refine((value) => !value.includes('?'), 'A command must not be a query. Use scpi_query instead.')
				.describe("SCPI command, for example ':CHANnel1:SCALe 5.00E-01'"),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command }, scope) =>
			scope.execute(async (session) => {
				await session.command(command);
				return { commands: [command] };
			}),
	}),
];
