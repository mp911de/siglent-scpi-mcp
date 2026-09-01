import type { ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { stripHeader } from '../../../scpi/values.ts';
import { applied, compare, flag, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import { mutating, readOnly, tool } from './define.ts';

// INR? clears the register it reports (p. 174): a query with a side effect, so neither read-only nor repeatable.
const clearOnRead: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

const BITS = 16;

const events: Record<number, string> = {
	0: 'new_signal_acquired',
	1: 'screen_dump_terminated',
	2: 'returned_to_local',
	3: 'data_block_transfer_timed_out',
	4: 'sequence_segment_acquired',
	6: 'storage_full_in_autostore_fill',
	7: 'storage_media_exchanged',
	8: 'trace_a_processing_terminated',
	9: 'trace_b_processing_terminated',
	10: 'trace_c_processing_terminated',
	11: 'trace_d_processing_terminated',
	12: 'pass_fail_outcome_detected',
	13: 'trigger_ready',
};

const isOn = (raw: string): boolean => stripHeader(raw).toUpperCase() === 'ON';

const params = [
	flag('buzzer', 'BUZZ', 'sound the buzzer', isOn),
	param(
		'screensaver',
		'SCSV',
		z.enum(['OFF', '1MIN', '5MIN', '10MIN', '30MIN', '60MIN']),
		'Idle time after which the monitor is blanked. The scope remains fully functional.',
		stripHeader,
	),
];

// EMOD names the function, not the lock: ON leaves the function usable, OFF is what education mode locks away.
const education = [
	flag('autosetup_enabled', 'AutoSetup', 'Leave Auto Setup usable. Disable to lock it.'),
	flag('measure_enabled', 'Measure', 'Leave measurements usable. Disable to lock them.'),
	flag('cursors_enabled', 'Cursors', 'Leave cursors usable. Disable to lock them.'),
];

const all = [...params, ...education];

function decodeStatus(raw: string): Values {
	const value = Number(stripHeader(raw));
	if (!Number.isInteger(value) || value < 0)
		throw new ScpiError(`The scope returned an invalid status event register: ${JSON.stringify(raw)}`);
	const set = [...Array(BITS).keys()].filter((bit) => value & (1 << bit));
	return {
		value,
		events: set.filter((bit) => events[bit]).map((bit) => ({ bit, event: events[bit] })),
		unknown_bits: set.filter((bit) => !events[bit]),
		cleared: true,
		raw,
	};
}

// Both documented shapes: 'EduMode AutoSetup,ON;' for one function, 'AutoSetup,OFF;Measure,ON;Cursors,ON;' for all.
function decodeEducation(raw: string): Values {
	const state: Values = {};
	for (const entry of stripHeader(raw).split(';')) {
		const [func = '', lock = ''] = entry.split(',').map((field) => field.trim());
		const row = education.find((p) => p.mnemonic.toUpperCase() === func.toUpperCase());
		if (row && lock) state[row.name] = lock.toUpperCase() === 'ON';
	}
	return state;
}

// `only` limits the read-back to what a request set; without it the whole table is read.
async function readSettings(session: ScpiSession, only?: Values): Promise<Values> {
	const rows = only ? applied(params, only) : params;
	const state = await readback(session, rows);
	if (only && !education.some(({ name }) => only[name] !== undefined)) return state;
	const raw = await session.query('EMOD?');
	return { ...state, ...decodeEducation(raw), education_mode_raw: raw };
}

export const systemSettingsTools = [
	tool({
		name: 'read_status_events',
		description:
			'Read and decode pending scope status events. Reading clears the event register for every reader. A second call returns zero until new events occur. Known events are decoded and unknown bits are preserved.',
		annotations: clearOnRead,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				return { commands: ['INR?'], ...decodeStatus(await session.query('INR?')) };
			}),
	}),
	tool({
		name: 'get_system_settings',
		description:
			'Read the buzzer, screensaver idle time, and education-mode function locks. Education fields report whether each function is usable. False means locked.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				return readSettings(session);
			}),
	}),
	tool({
		name: 'configure_system_settings',
		description:
			'Configure the buzzer, screensaver idle time, and education-mode function locks. Each education field controls whether the function remains usable. Set it to false to lock the function.',
		input: z.object(inputs(all)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const locks = education
				.filter((p) => input[p.name] !== undefined)
				.map((p) => `EMOD ${p.mnemonic},${onOff(input[p.name] as boolean)}`);
			const commands = plan(...settings(params, input), ...locks);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				for (const command of commands) await session.command(command);
				const state = await readSettings(session, input);
				compare(scope, all, input, state);
				return { commands, state };
			});
		},
	}),
];
