import * as z from 'zod';
import { Instrument, type InstrumentOptions } from '../scpi/instrument.ts';
import { destructive, readOnly, tool } from '../tools/define.ts';
import { singleLine, timeoutMs } from '../tools/schema.ts';
import type { Driver } from './index.ts';

const tools = [
	tool({
		name: 'identify',
		description: 'Identify the connected instrument and return its manufacturer, model, serial number, and firmware.',
		annotations: readOnly,
		handler: async (_, instrument) => {
			const identity = await instrument.execute((session) => instrument.identify(session));
			return { ...identity, target: instrument.target };
		},
	}),
	tool({
		name: 'status',
		description:
			'Report the connection state, target address, and last known identity without contacting the instrument.',
		annotations: readOnly,
		handler: async (_, instrument) => ({ ...instrument.status() }),
	}),
	tool({
		name: 'scpi_query',
		description:
			'Send a raw SCPI query and return its text response. This instrument has no typed tools, so consult its programming guide before sending a query. Some queries have side effects.',
		input: z.object({
			command: singleLine.regex(/\?/, 'A SCPI query must contain ?.').describe("SCPI query, for example '*IDN?'"),
			timeout_ms: timeoutMs,
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command, timeout_ms }, instrument) =>
			instrument.execute(async (session) => ({
				commands: [command],
				response: await session.query(command, timeout_ms),
			})),
	}),
	tool({
		name: 'scpi_command',
		description:
			'Send a raw SCPI command without reading a response. This instrument has no typed tools, so consult its programming guide for the commands it takes.',
		input: z.object({
			command: singleLine
				.refine((value) => !value.includes('?'), 'A SCPI command cannot contain ?. Use scpi_query for queries.')
				.describe("SCPI command, for example '*RST'"),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command }, instrument) =>
			instrument.execute(async (session) => {
				await session.command(command);
				return { commands: [command] };
			}),
	}),
];

export const unknown: Driver = {
	kind: 'unknown',
	label: 'generic SCPI driver',
	matches: () => true,
	create: (target, options?: InstrumentOptions) => new Instrument(target, options),
	tools,
	instructions: `Controls a Siglent instrument over raw SCPI. The model was not recognized, so no typed tools are
available and command support is unknown. Use scpi_query and scpi_command with the instrument's own programming guide.`,
	describe(instrument) {
		const { identity } = instrument;
		return {
			facts: identity ? [`firmware ${identity.firmware}`] : [],
			warnings: [
				'Unrecognized instrument. Only identify, status, and raw SCPI tools are available. Command support is unknown.',
			],
		};
	},
};
