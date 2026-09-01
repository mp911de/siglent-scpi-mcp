import * as z from 'zod';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { stripHeader } from '../../../scpi/values.ts';
import type { PowerSupply } from '../supply.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import { singleLine, timeoutMs } from './schema.ts';

// The SPD1000X manual documents five front-panel save/recall locations (p. 19); the SPD3303C
// quickstart shows only the example `*SAV 1`, so the same closed range is used for both.
const slot = z.number().int().min(1).max(5).describe('Saved-state location 1-5');

// SYSTem:STATus? answers hexadecimal ('0x0224'); the bit layouts differ per command set and an SPD family
// outside both sets gets the raw value only, never a guessed decode.
function decodeStatus(supply: PowerSupply, raw: string): Record<string, unknown> {
	const value = Number.parseInt(stripHeader(raw), 16);
	if (Number.isNaN(value)) return { raw };
	const bit = (index: number) => (value >> index) & 1;
	const { set } = supply.capabilities ?? {};
	if (set === 'SPD1000X') {
		return {
			mode: bit(0) ? 'CC' : 'CV',
			output: bit(4) === 1,
			wire_mode: bit(5) ? '4W' : '2W',
			timer: bit(6) === 1,
			display: bit(8) ? 'waveform' : 'digital',
			raw,
		};
	}
	if (set === 'SPD3303') {
		const track = { 1: 'independent', 2: 'parallel', 3: 'series' }[(value >> 2) & 3];
		return {
			ch1_mode: bit(0) ? 'CC' : 'CV',
			ch2_mode: bit(1) ? 'CC' : 'CV',
			track,
			ch1_output: bit(4) === 1,
			ch2_output: bit(5) === 1,
			raw,
		};
	}
	supply.warn('The working-state format is unknown for this model. Only the raw value is returned.');
	return { raw };
}

const send = (session: ScpiSession, command: string) =>
	session.command(command).then(() => ({ commands: [command], write_only: [command.split(' ')[0] ?? command] }));

export const systemTools = [
	tool({
		name: 'identify',
		description:
			'Identify the connected power supply. Returns its manufacturer, model, serial number, firmware, family, command set, and channel count.',
		annotations: readOnly,
		// PowerSupply.identify() performs the *IDN? exchange used by this tool.
		handler: async (_, supply) => {
			const identity = await supply.execute((session) => supply.identify(session));
			return { ...identity, capabilities: supply.capabilities, target: supply.target };
		},
	}),
	tool({
		name: 'get_power_status',
		description:
			'Read the working state, software version, and selected channel. The working state is hexadecimal and kept in raw. Models outside the recognized SPD families receive only the raw value.',
		annotations: readOnly,
		handler: (_, supply) =>
			supply.execute(async (session) => {
				supply.requireDocumented();
				const version = stripHeader(await session.query('SYSTem:VERSion?'));
				const selected = stripHeader(await session.query('INSTrument?'));
				const raw = await session.query('SYSTem:STATus?');
				return { status: decodeStatus(supply, raw), selected_channel: selected, version };
			}),
	}),
	tool({
		name: 'save_state',
		description:
			'Save the current instrument state to location 1-5. An existing state may be overwritten because occupied locations cannot be checked. Requires confirm_overwrite: true. Nothing is sent otherwise.',
		input: z.object({
			slot,
			confirm_overwrite: z.literal(true).describe('Acknowledge that this location may hold a state that will be lost'),
		}),
		annotations: destructive,
		handler: ({ slot }, supply) =>
			supply.execute((session) => {
				supply.requireDocumented();
				return send(session, `*SAV ${slot}`);
			}),
	}),
	tool({
		name: 'recall_state',
		description:
			'Recall saved state 1-5, replacing the current settings, including output values. Requires confirm_recall: true. Nothing is sent otherwise.',
		input: z.object({
			slot,
			confirm_recall: z.literal(true).describe('Acknowledge that the current settings will be replaced'),
		}),
		annotations: destructive,
		handler: ({ slot }, supply) =>
			supply.execute((session) => {
				supply.requireDocumented();
				return send(session, `*RCL ${slot}`);
			}),
	}),
	tool({
		name: 'delete_state',
		description:
			'Delete saved state 1-5. Available on SPD1000X only. Requires confirm_delete: true. Nothing is sent otherwise.',
		input: z.object({
			slot,
			confirm_delete: z.literal(true).describe('Acknowledge that the saved state will be lost'),
		}),
		annotations: destructive,
		handler: ({ slot }, supply) =>
			supply.execute((session) => {
				supply.require('deleteSavedStates');
				return send(session, `*DEL ${slot}`);
			}),
	}),
	tool({
		name: 'lock_front_panel',
		description:
			'Lock or unlock the front-panel keys. The lock state cannot be read back because these commands have no query form.',
		input: z.object({ locked: z.boolean().describe('Set to true to lock the keys or false to unlock them') }),
		annotations: mutating,
		exposure: 'lock',
		handler: ({ locked }, supply) =>
			supply.execute((session) => {
				supply.requireDocumented();
				return send(session, locked ? '*LOCK' : '*UNLOCK');
			}),
	}),
	tool({
		name: 'scpi_query',
		description:
			'Send a raw SCPI query and return its text response. Use for operations without a typed tool. An unsupported or non-responsive query can block until the timeout closes the connection.',
		input: z.object({
			command: singleLine
				.regex(/\?/, 'Enter a query containing ?.')
				.describe("SCPI query, for example 'SYSTem:ERRor?'"),
			timeout_ms: timeoutMs,
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command, timeout_ms }, supply) =>
			supply.execute(async (session) => ({ commands: [command], response: await session.query(command, timeout_ms) })),
	}),
	tool({
		name: 'scpi_command',
		description: 'Send a raw SCPI command without reading a response. Use for operations without a typed tool.',
		input: z.object({
			command: singleLine
				.refine((value) => !value.includes('?'), 'Enter a command without ?. Use scpi_query for queries.')
				.describe("SCPI command, for example 'OUTPut CH1,OFF'"),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command }, supply) =>
			supply.execute(async (session) => {
				await session.command(command);
				return { commands: [command] };
			}),
	}),
];
