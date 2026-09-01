import * as z from 'zod';
import { nr3, onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, isOn, parseFields, quoted, unquote } from '../../../scpi/values.ts';
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
import type { ScpiScope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const POINTS = ':DIGital:POINts';
const SRATE = ':DIGital:SRATe';
const LINE = ':DIGital:D<d>';
const LABEL = ':DIGital:LABel<d>';
const THRESHOLD = ':DIGital:THReshold<n>';
const BUS_DISPLAY = ':DIGital:BUS<n>:DISPlay';
const BUS_DEFAULT = ':DIGital:BUS<n>:DEFault';
const BUS_FORMAT = ':DIGital:BUS<n>:FORMat';
const BUS_MAP = ':DIGital:BUS<n>:MAP';

const digitals = [
	'D0',
	'D1',
	'D2',
	'D3',
	'D4',
	'D5',
	'D6',
	'D7',
	'D8',
	'D9',
	'D10',
	'D11',
	'D12',
	'D13',
	'D14',
	'D15',
] as const;
const digital = z.enum(digitals);
const groupNames = ['d0_d7', 'd8_d15'] as const;
const busNames = ['bus1', 'bus2'] as const;
const groups: Record<Group, string> = { d0_d7: '1', d8_d15: '2' };
const buses: Record<Bus, string> = { bus1: '1', bus2: '2' };
const presets = ['TTL', 'CMOS', 'LVCMOS33', 'LVCMOS25', 'CUSTom'] as const;
const formats = ['BINary', 'DECimal', 'UDECimal', 'HEX'] as const;

type Group = (typeof groupNames)[number];
type Bus = (typeof busNames)[number];

const at = (mnemonic: string, index: string): string => mnemonic.replace(/<[nd]>/, index);
const suffix = (line: string): string => line.slice(1);
const given = (parts: Array<string | false | undefined>): string[] =>
	parts.filter((part): part is string => typeof part === 'string');

// Quoted on the wire; everything with a meaning in the command grammar is excluded.
const label = z
	.string()
	.max(8)
	.regex(/^[A-Za-z0-9 _+.-]*$/, 'up to 8 of A-Z, a-z, 0-9, space, underscore, plus, dot or hyphen');

const enabled = flag('enabled', ':DIGital', 'the digital function itself', isOn);
const active = param('active', ':DIGital:ACTive', digital, 'the selected digital channel', (raw) =>
	asState(raw, digitals),
);

// The guide bounds the height ([4, 8] divisions, p. 200) and the skew ([-1E-7, 1E-7], p. 204). The position range
// "varies with the number of digital channels displayed" (p. 203), so its bound keeps the value inside the eight
// divisions of the waveform area and leaves the rest to the scope, which comes back as a warning.
const geometry: Param[] = [
	{
		...clamped(
			'height',
			':DIGital:HEIGht',
			z.number().min(4).max(8),
			'height of the digital waveform in divisions, 4 to 8',
			asQuantity,
			1e-3,
		),
		wire: nr3,
	},
	{
		...clamped(
			'position',
			':DIGital:POSition',
			z.number().min(-8).max(8),
			'Position of the digital waveform in divisions from the top of the waveform area. The legal range follows how many digital channels are displayed',
			asQuantity,
			1e-3,
		),
		wire: nr3,
	},
	{
		...clamped(
			'skew',
			':DIGital:SKEW',
			z.number().min(-1e-7).max(1e-7),
			'digital channel skew in seconds, -100 ns to 100 ns',
			asQuantity,
			1e-12,
		),
		wire: nr3,
	},
];

const threshold = z
	.strictObject({
		mode: z.enum(presets).describe('Threshold preset for the group. CUSTom selects the custom level'),
		custom: z.number().min(-10).max(10).optional().describe('Custom threshold in volts. Requires CUSTom mode'),
	})
	.refine(({ mode, custom }) => custom === undefined || mode === 'CUSTom', {
		message: 'custom requires mode CUSTom',
		path: ['custom'],
	});

const bus = z
	.strictObject({
		display: z.boolean().optional().describe('Show or hide the bus'),
		format: z.enum(formats).optional().describe('display format of the bus data'),
		map: z
			.array(digital)
			.min(1)
			.max(16)
			.optional()
			.describe('Bit order of the bus in LSB order. The number of entries sets the bus width'),
		default_map: z.literal(true).optional().describe('Reset the bit order to D0-D15 at the current bus width'),
	})
	.refine(({ map, default_map }) => map === undefined || default_map === undefined, {
		message: 'map and default_map are exclusive. Send the order you want or the reset, not both',
		path: ['default_map'],
	});

type Threshold = z.output<typeof threshold>;
type BusSpec = z.output<typeof bus>;
type BusFields = { display?: boolean; format?: boolean; map?: boolean };

// The DIGital subsystem is headed [Option] and *IDN? does not report whether the MSO option is fitted.
const msoUnknown = (scope: ScpiScope): void =>
	scope.warn(
		'Digital support cannot be determined from the model identity. On a scope without the MSO option this request may time out and close the connection',
	);

// p. 206 prints a [-8E-1, 8E-1] custom range for the SDS1000X HD and SDS800X HD, which the TTL preset itself (1.5 V)
// exceeds, so a value outside it is sent with a warning rather than refused and the read-back decides.
const narrowRange = /^SDS(8\d{2}|1\d{3})X[ -]?HD/i;

function warnNarrowThreshold(scope: ScpiScope, thresholds: Partial<Record<Group, Threshold>> | undefined): void {
	const model = scope.identity?.model ?? '';
	if (!narrowRange.test(model)) return;
	for (const [group, spec] of Object.entries(thresholds ?? {})) {
		if (spec.custom !== undefined && Math.abs(spec.custom) > 0.8) {
			scope.warn(
				`thresholds.${group} exceeds the known -0.8 V to 0.8 V custom range for ${model}. The value was sent and the returned state shows what the scope kept`,
			);
		}
	}
}

const thresholdCommand = (group: Group, { mode, custom }: Threshold): string =>
	`${at(THRESHOLD, groups[group])} ${mode}${custom === undefined ? '' : `,${nr3(custom)}`}`;

const busCommands = (name: Bus, { display, format, map, default_map }: BusSpec): string[] =>
	given([
		display !== undefined && `${at(BUS_DISPLAY, buses[name])} ${onOff(display)}`,
		default_map && at(BUS_DEFAULT, buses[name]),
		format && `${at(BUS_FORMAT, buses[name])} ${format}`,
		map && `${at(BUS_MAP, buses[name])} ${map.join(',')}`,
	]);

async function readLines(session: ScpiSession, lines: readonly string[]): Promise<Values> {
	const state: Values = {};
	for (const line of lines) state[line] = isOn(await session.query(`${at(LINE, suffix(line))}?`));
	return state;
}

async function readLabels(session: ScpiSession, lines: readonly string[]): Promise<Values> {
	const state: Values = {};
	for (const line of lines) state[line] = unquote(await session.query(`${at(LABEL, suffix(line))}?`));
	return state;
}

function decodeThreshold(raw: string) {
	const [first = '', value] = parseFields(raw);
	return {
		mode: asState(first, presets),
		...(value !== undefined && { custom: asQuantity(value) }),
		raw,
	};
}

async function readThresholds(session: ScpiSession, wanted: readonly Group[]) {
	const state: Partial<Record<Group, ReturnType<typeof decodeThreshold>>> = {};
	for (const group of wanted) state[group] = decodeThreshold(await session.query(`${at(THRESHOLD, groups[group])}?`));
	return state;
}

async function readBus(session: ScpiSession, name: Bus, fields: BusFields): Promise<Values> {
	const index = buses[name];
	return {
		...(fields.display && { display: isOn(await session.query(`${at(BUS_DISPLAY, index)}?`)) }),
		...(fields.format && { format: asState(await session.query(`${at(BUS_FORMAT, index)}?`), formats) }),
		...(fields.map && { map: parseFields(await session.query(`${at(BUS_MAP, index)}?`)) }),
	};
}

async function readBuses(session: ScpiSession, wanted: Partial<Record<Bus, BusFields>>): Promise<Values> {
	const state: Values = {};
	for (const [name, fields] of Object.entries(wanted)) state[name] = await readBus(session, name as Bus, fields);
	return state;
}

const touched = ({ display, format, map, default_map }: BusSpec): BusFields => ({
	display: display !== undefined,
	format: format !== undefined,
	map: map !== undefined || default_map === true,
});

const everything: BusFields = { display: true, format: true, map: true };

function verifyRecord(scope: ScpiScope, kind: string, wanted: Values | undefined, kept: unknown): void {
	for (const [key, value] of Object.entries(wanted ?? {})) {
		const actual = (kept as Values | undefined)?.[key];
		if (actual !== undefined && String(actual) !== String(value)) {
			scope.warn(`${kind}.${key} was set to ${JSON.stringify(value)} but the scope reports ${JSON.stringify(actual)}`);
		}
	}
}

function verifyThresholds(
	scope: ScpiScope,
	wanted: Partial<Record<Group, Threshold>> | undefined,
	kept: Awaited<ReturnType<typeof readThresholds>>,
): void {
	for (const [group, spec] of Object.entries(wanted ?? {})) {
		const state = kept[group as Group];
		if (!state) continue;
		const value = state.custom && 'value' in state.custom ? state.custom.value : undefined;
		const moved =
			spec.custom !== undefined &&
			(value === undefined || Math.abs(value - spec.custom) > Math.max(Math.abs(spec.custom) * 1e-3, 1e-3));
		if (state.mode !== spec.mode || moved) {
			scope.warn(
				`thresholds.${group} was set to ${JSON.stringify(spec)} but the scope reports ${JSON.stringify(state.raw)}`,
			);
		}
	}
}

export const digitalTools = [
	tool({
		name: 'get_digital',
		description:
			'Read the digital function state, the active channel, waveform height and position, skew, per-line visibility and labels, the D0-D7 and D8-D15 thresholds and the two digital buses. The sample rate and points are read only while the digital function is on. Whether the MSO option is installed cannot be determined from the model identity.',
		input: z.strictObject({
			lines: z
				.array(digital)
				.default([...digitals])
				.describe('Digital lines to read. Defaults to D0-D15'),
		}),
		annotations: readOnly,
		handler: ({ lines }, scope) =>
			scope.execute(async (session) => {
				msoUnknown(scope);
				const state = await readback(session, [enabled]);
				if (state.enabled !== true) {
					scope.warn('The digital function is not on, so the sample rate and points were not read');
				}
				return {
					...state,
					...(await readback(session, [active, ...geometry])),
					...(state.enabled === true && {
						sample_rate: asQuantity(await session.query(`${SRATE}?`)),
						points: asQuantity(await session.query(`${POINTS}?`)),
					}),
					lines: await readLines(session, lines),
					labels: await readLabels(session, lines),
					thresholds: await readThresholds(session, groupNames),
					buses: await readBuses(session, { bus1: everything, bus2: everything }),
				};
			}),
	}),
	tool({
		name: 'configure_digital',
		description:
			'Turn the digital function on or off, select the active channel, show or hide lines D0-D15, label them, set the waveform height, position and skew, the D0-D7 and D8-D15 thresholds and the two digital buses, then read back the requested values. Whether the MSO option is installed cannot be determined from the model identity. Values the scope did not take are returned with a warning.',
		input: z.strictObject({
			...inputs([enabled, active]),
			lines: z
				.partialRecord(digital, z.boolean())
				.optional()
				.describe('Display state per digital line, e.g. { D0: true, D8: false }'),
			labels: z.partialRecord(digital, label).optional().describe('Label text per digital line, up to 8 characters'),
			...inputs(geometry),
			thresholds: z
				.partialRecord(z.enum(groupNames), threshold)
				.optional()
				.describe("Thresholds of the D0-D7 and D8-D15 groups, e.g. { d0_d7: { mode: 'CMOS' } }"),
			buses: z
				.partialRecord(z.enum(busNames), bus)
				.optional()
				.describe("The two digital buses, e.g. { bus1: { display: true, map: ['D0', 'D3'] } }"),
		}),
		annotations: mutating,
		handler: (input, scope) => {
			const { lines, labels, thresholds, buses: wantedBuses } = input;
			const values = input as Values;
			const commands = plan(
				...settings([enabled, active], values),
				...Object.entries(lines ?? {}).map(([line, on]) => `${at(LINE, suffix(line))} ${onOff(on)}`),
				...Object.entries(labels ?? {}).map(([line, text]) => `${at(LABEL, suffix(line))} ${quoted(text)}`),
				...settings(geometry, values),
				...Object.entries(thresholds ?? {}).map(([group, spec]) => thresholdCommand(group as Group, spec)),
				...Object.entries(wantedBuses ?? {}).flatMap(([name, spec]) => busCommands(name as Bus, spec)),
			);
			return scope.execute(async (session) => {
				msoUnknown(scope);
				warnNarrowThreshold(scope, thresholds);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(await readback(session, applied([enabled, active], values))),
					...(lines && { lines: await readLines(session, Object.keys(lines)) }),
					...(labels && { labels: await readLabels(session, Object.keys(labels)) }),
					...(await readback(session, applied(geometry, values))),
					...(thresholds && { thresholds: await readThresholds(session, Object.keys(thresholds) as Group[]) }),
					...(wantedBuses && {
						buses: await readBuses(
							session,
							Object.fromEntries(Object.entries(wantedBuses).map(([name, spec]) => [name, touched(spec)])),
						),
					}),
				};
				compare(scope, [enabled, active, ...geometry], values, state);
				verifyRecord(scope, 'lines', lines, state.lines);
				verifyRecord(scope, 'labels', labels, state.labels);
				verifyThresholds(scope, thresholds, (state.thresholds ?? {}) as Awaited<ReturnType<typeof readThresholds>>);
				return { commands, state };
			});
		},
	}),
];
