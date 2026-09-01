import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import {
	asQuantities,
	asQuantity,
	asState,
	parseFields,
	parseKeyValues,
	parseQuantity,
	type Quantity,
	stripHeader,
} from '../../../scpi/values.ts';
import { flag, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Scope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import { channel, seconds } from './schema.ts';

const parameter = z.enum([
	'PKPK',
	'MAX',
	'MIN',
	'AMPL',
	'TOP',
	'BASE',
	'CMEAN',
	'MEAN',
	'RMS',
	'CRMS',
	'OVSN',
	'FPRE',
	'OVSP',
	'RPRE',
	'PER',
	'FREQ',
	'PWID',
	'NWID',
	'RISE',
	'FALL',
	'WID',
	'DUTY',
	'NDUTY',
	'ALL',
]);

const slot = z.literal([1, 2, 3, 4, 5]);

const statistics = [
	param(
		'statistics',
		'PASTAT',
		z.enum(['OFF', 'ON', 'RESET']),
		'Measurement statistics. On accumulates current, mean, minimum, maximum, standard deviation, and count. Off stops accumulation. Reset clears accumulated values.',
		(raw) => asState(raw, ['OFF', 'ON'] as const),
	),
];

const delayType = z.enum(['PHA', 'FRR', 'FRF', 'FFR', 'FFF', 'LRR', 'LRF', 'LFR', 'LFF', 'SKEW']);

const gate = [
	flag('enabled', 'MEGS', 'gate measurement: only the waveform between gate A and gate B is measured', (raw) =>
		asState(raw, ['OFF', 'ON'] as const),
	),
	param('gate_a', 'MEGA', seconds, "Left gate position, for example '20us'. A value without a unit means seconds."),
	param('gate_b', 'MEGB', seconds, "right gate position, never before gate A, e.g. '1.68ms'"),
];

const gateWriteOnly = ['MEGA', 'MEGB'];

const custom = /CUST(\d)\s*:\s*(.*)$/i;
const statistic = /STAT(\d)\s+(\S+)\s+([^\s:]+)\s*:\s*(.*)$/i;

const readValue = (raw: string, name: string) =>
	name === 'ALL'
		? { values: asQuantities(parseKeyValues(raw)) }
		: { value: asQuantity(parseFields(raw, name).at(-1) ?? raw) };

async function readParameter(session: ScpiSession, source: string, name: string) {
	const raw = await session.query(`${source}:PAVA? ${name}`);
	return { channel: source, parameter: name, ...readValue(raw, name), raw };
}

const below = /^<\s*(\S.*)$/;

async function readCounter(session: ScpiSession, scope: Scope) {
	const raw = await session.query('CYMT?');
	const value = stripHeader(raw);
	const bound = below.exec(value)?.[1];
	if (bound) return { below: asQuantity(bound), raw };
	const frequency = asQuantity(value);
	if ('value' in frequency && frequency.value === 10 && frequency.unit === 'Hz') {
		scope.warn(
			'The counter reports 10Hz for both a 10 Hz signal and slower signals. Treat this reading as an upper bound.',
		);
	}
	return { frequency, raw };
}

async function readDelay(session: ScpiSession, sources: string, type: string) {
	const raw = await session.query(`${sources}:MEAD? ${type}`);
	return { sources, type, value: asQuantity(parseFields(raw, type).at(-1) ?? raw), raw };
}

const secondsOf = (value: unknown) => parseQuantity(String(value ?? ''))?.value;

function reportGate(scope: Scope, input: Values): void {
	if (input.gate_a === undefined && input.gate_b === undefined) return;
	scope.warn(
		'Gate positions have no query form and cannot be verified. The scope may clamp them to the timebase and horizontal position.',
	);
}

interface Slot {
	slot: number;
	installed: boolean;
	source?: string;
	parameter?: string;
	value?: Quantity | { raw: string };
}

function parseSlots(raw: string): Slot[] {
	const slots: Slot[] = [];
	for (const entry of raw.split(';')) {
		const [, index, body = ''] = custom.exec(entry) ?? [];
		if (!index) continue;
		const [source, name, value] = body.split(',').map((field) => field.trim());
		const found = { slot: Number(index), installed: value !== undefined };
		slots.push(found.installed ? { ...found, source, parameter: name, value: asQuantity(value ?? '') } : found);
	}
	return slots;
}

async function readStatistics(session: ScpiSession, index: number) {
	const raw = await session.query(`PAVA? STAT${index}`);
	const [, , source, name, body = ''] = statistic.exec(raw.trim()) ?? [];
	return { slot: index, source, parameter: name, statistics: asQuantities(parseKeyValues(body)), raw };
}

export const measureTools = [
	tool({
		name: 'read_frequency_counter',
		description:
			'Read the hardware frequency counter for the current trigger source and slope. Signals below 10 Hz are returned as a bound. A plain 10 Hz result may also represent a slower signal and includes a warning.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				return readCounter(session, scope);
			}),
	}),
	tool({
		name: 'measure_delay',
		description:
			'Install and read a delay measurement between channels C1-C4. This enables continuous measurement mode and changes the measurement pane. Phase is returned in degrees. Edge delays and skew are returned as times. The first source must precede the second.',
		input: z
			.object({
				source_a: channel.describe('First channel of the pair.'),
				source_b: channel.describe('Second channel of the pair. Must follow source_a.'),
				type: delayType.describe('Delay type. Phase is measured in degrees.'),
			})
			.refine(({ source_a, source_b }) => source_a < source_b, {
				message: 'source_b must follow source_a. Use C1-C2, C1-C3, C1-C4, C2-C3, C2-C4, or C3-C4.',
				path: ['source_b'],
			}),
		annotations: mutating,
		handler: ({ source_a, source_b, type }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(source_a);
				scope.requireChannel(source_b);
				const sources = `${source_a}-${source_b}`;
				const command = `MEAD ${type},${sources}`;
				await session.command(command);
				return { commands: [command], ...(await readDelay(session, sources, type)) };
			}),
	}),
	tool({
		name: 'measure',
		description:
			'Install a measurement on a channel and read its value. Installing it changes the measurement pane. A single parameter returns its value and unit. All returns every available parameter. Unavailable values are preserved as raw text.',
		input: z.object({
			channel,
			parameter: parameter.describe('Measurement parameter, ALL snapshots every parameter into values'),
		}),
		annotations: mutating,
		handler: ({ channel: source, parameter: name }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(source);
				const command = `PACU ${name},${source}`;
				await session.command(command);
				return { commands: [command], ...(await readParameter(session, source, name)) };
			}),
	}),
	tool({
		name: 'read_measurement',
		description:
			'Read one measurement parameter from a channel without installing it or using a custom slot. All returns every available parameter. Unavailable values are preserved as raw text.',
		input: z.object({
			channel,
			parameter: parameter.describe('Measurement parameter, ALL snapshots every parameter into values'),
		}),
		annotations: readOnly,
		handler: ({ channel: source, parameter: name }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(source);
				return readParameter(session, source, name);
			}),
	}),
	tool({
		name: 'list_measurements',
		description:
			'List installed measurements with their slot number, source channel, parameter, and current value. A slot reported as Off is available.',
		input: z.object({ slot: slot.optional().describe('Read one custom slot 1-5 instead of all five') }),
		annotations: readOnly,
		handler: ({ slot: index }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const raw = await session.query(`PAVA? CUST${index ?? 'ALL'}`);
				return { slots: parseSlots(raw), raw };
			}),
	}),
	tool({
		name: 'get_measurement_statistics',
		description:
			'Read current, mean, minimum, maximum, standard deviation, and count for installed measurements. Filter by channel or parameter, or read every installed slot. Statistics must be enabled first with configure_measurement_statistics. SDS1000X-E only.',
		input: z.object({
			channel: channel.optional().describe('Only report slots measuring this channel'),
			parameter: parameter.optional().describe('Only report slots measuring this parameter'),
		}),
		annotations: readOnly,
		handler: ({ channel: source, parameter: name }, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				if (source) scope.requireChannel(source);
				const { statistics: accumulating } = await readback(session, statistics);
				if (accumulating === 'OFF') {
					throw new ScpiError(
						'Measurement statistics are off. Enable them with configure_measurement_statistics before reading statistics.',
					);
				}
				if (accumulating !== 'ON') {
					scope.warn(
						'The measurement statistics state was not recognized. Statistics were read without confirming that accumulation is enabled.',
					);
				}
				const raw = await session.query('PAVA? CUSTALL');
				const slots = parseSlots(raw);
				const wanted = slots.filter(
					(entry) => entry.installed && (!source || entry.source === source) && (!name || entry.parameter === name),
				);
				if (wanted.length === 0) {
					const answered = `The scope returned ${JSON.stringify(raw)}`;
					if (source || name) {
						throw new ScpiError(
							`No custom slot measures ${[name, source].filter(Boolean).join(' on ')}. Install it with measure first. ${answered}.`,
						);
					}
					scope.warn(
						`No measurement is installed, so there are no statistics to read. Install one with measure. ${answered}.`,
					);
				}
				const measurements = [];
				for (const entry of wanted) measurements.push(await readStatistics(session, entry.slot));
				return { statistics: accumulating, slots, measurements, raw };
			}),
	}),
	tool({
		name: 'configure_measurement_statistics',
		description:
			'Turn measurement statistics on or off, or clear accumulated values. Statistics apply to measurements installed with measure. Read them with get_measurement_statistics. Reset has no query form. SDS1000X-E only.',
		input: z.object(inputs(statistics)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(statistics, input));
			return scope.execute(async (session) => {
				scope.require('xe');
				for (const command of commands) await session.command(command);
				return { commands, state: await readback(session, statistics) };
			});
		},
	}),
	tool({
		name: 'clear_measurements',
		description:
			'Remove every installed measurement and free all custom slots. Individual slots or channels cannot be cleared. This cannot be undone. The command has no query form. SDS1000X-E only.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				await session.command('MEACL');
				return { commands: ['MEACL'] };
			}),
	}),
	tool({
		name: 'get_measurement_gate',
		description:
			'Read whether measurement gating is enabled. Gate positions have no query form and cannot be read back. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				return { ...(await readback(session, gate)), write_only: gateWriteOnly };
			}),
	}),
	tool({
		name: 'configure_measurement_gate',
		description:
			'Turn measurement gating on or off and set the left and right gate positions. Only the waveform between them is measured. Positions require a time unit and may be clamped to the timebase and horizontal position. Gate positions have no query form and cannot be verified. Gate A must not follow gate B. SDS1000X-E only.',
		input: z
			.object(inputs(gate))
			.refine(({ gate_a, gate_b }) => (secondsOf(gate_a) ?? -Infinity) <= (secondsOf(gate_b) ?? Infinity), {
				message: 'gate_a must not follow gate_b. Move gate_a earlier or gate_b later.',
				path: ['gate_a'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(gate, input));
			return scope.execute(async (session) => {
				scope.require('xe');
				for (const command of commands) await session.command(command);
				reportGate(scope, input);
				return { commands, state: await readback(session, gate), write_only: gateWriteOnly };
			});
		},
	}),
];
