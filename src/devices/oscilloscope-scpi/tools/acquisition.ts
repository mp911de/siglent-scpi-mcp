import * as z from 'zod';
import { nr3, onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { asQuantity, asState, isOn, parseFields, parseState } from '../../../scpi/values.ts';
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
import { probesResolution } from '../models.ts';
import { counted, RESOLUTION, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const TYPE = ':ACQuire:TYPE';
const CSWEEP = ':ACQuire:CSWeep';
const NUMACQ = ':ACQuire:NUMAcq';
const POINTS = ':ACQuire:POINts';

const rates = ['FAST', 'SLOW'] as const;
const modes = ['YT', 'XY', 'ROLL'] as const;
const memoryModes = ['AUTO', 'FSRate', 'FMDepth'] as const;
const resolutions = ['8Bits', '10Bits'] as const;
const types = ['NORMal', 'PEAK', 'AVERage', 'ERES'] as const;
const interpolations = ['sine', 'linear'] as const;
const averages = [4, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;
const enhancedBits = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4] as const;

// The union of the per-model tables of pp. 40-41, ascending: which of them a model takes depends on its series and
// on how many channels are on, so the scope decides and a value it did not take comes back as a warning.
const depths = [
	'1k',
	'1.25k',
	'2k',
	'2.5k',
	'5k',
	'6k',
	'10k',
	'12k',
	'12.5k',
	'20k',
	'25k',
	'50k',
	'60k',
	'100k',
	'120k',
	'125k',
	'200k',
	'250k',
	'500k',
	'600k',
	'625k',
	'1M',
	'1.2M',
	'1.25M',
	'2M',
	'2.5M',
	'5M',
	'6M',
	'6.25M',
	'10M',
	'12M',
	'12.5M',
	'20M',
	'25M',
	'50M',
	'62.5M',
	'100M',
	'125M',
	'200M',
	'250M',
	'400M',
	'500M',
	'1G',
] as const;

// Written from the table, read through the scope so the cached ADC state follows every read.
const resolution = param(
	'resolution',
	RESOLUTION,
	z.enum(resolutions),
	'ADC resolution. Available on SDS2000X Plus models',
);

const before: Param[] = [
	param(
		'mode',
		':ACQuire:MODE',
		z.enum(modes),
		'Acquisition mode. YT plots amplitude over time, XY plots one channel against another and Roll draws slow signals from the right of the screen',
		(raw) => asState(raw, modes),
	),
	param(
		'capture_rate',
		':ACQuire:AMODe',
		z.enum(rates),
		'Waveform capture rate. Fast favours signal anomalies and Slow is the ordinary rate',
		(raw) => asState(raw, rates),
	),
	{
		...param(
			'interpolation',
			':ACQuire:INTerpolation',
			z.enum(interpolations),
			'Waveform interpolation. Sine uses sin(x)/x interpolation',
			(raw) => (isOn(raw) ? 'sine' : 'linear'),
		),
		wire: (value) => onOff(value === 'sine'),
	},
	flag('sequence', ':ACQuire:SEQuence', 'sequence mode, which records segments back to back', isOn),
	param(
		'sequence_count',
		':ACQuire:SEQuence:COUNt',
		z.number().int().min(1).max(100_000),
		'Number of memory segments to acquire. Memory depth and timebase may limit the accepted count',
		counted('sequence_count'),
	),
];

// The type carries its own argument, so it is built by hand; these rows exist for the input schema and the read-back
// comparison only, which is why they have no parser.
const composite: Param[] = [
	param('acquisition_type', TYPE, z.enum(types), 'data acquisition type'),
	param('average_count', TYPE, z.literal(averages), 'Number of averages. Requires acquisition_type Average.'),
	param('enhanced_bits', TYPE, z.literal(enhancedBits), 'enhanced resolution bits, with acquisition_type ERES'),
];

const after: Param[] = [
	param(
		'memory_management',
		':ACQuire:MMANagement',
		z.enum(memoryModes),
		'Memory management strategy. Auto maximises sample rate, Fixed Sample Rate preserves sample_rate and Fixed Memory Depth preserves memory_depth',
		(raw) => asState(raw, memoryModes),
	),
	param(
		'memory_depth',
		':ACQuire:MDEPth',
		z.enum(depths),
		'Maximum memory depth. Available values vary by model, enabled channels and acquisition mode',
		(raw) => asState(raw, depths),
	),
	{
		...clamped(
			'sample_rate',
			':ACQuire:SRATe',
			z.number().min(1).max(1e12),
			'Sampling rate in samples per second. Fixed Sample Rate memory management preserves this value. Unsupported rates are reduced to the nearest available value',
			asQuantity,
			1,
		),
		wire: nr3,
	},
];

const all = [resolution, ...before, ...composite, ...after];

function decodeType(raw: string): Values {
	const [type = '', argument] = parseFields(raw);
	const state = parseState(type, types);
	const value = argument === undefined ? undefined : counted('the acquisition type argument')(argument);
	return {
		acquisition_type: state ?? { raw },
		...(state === 'AVERage' && { average_count: value }),
		...(state === 'ERES' && { enhanced_bits: value }),
		acquisition_type_raw: raw,
	};
}

const typeCommand = ({ acquisition_type, average_count, enhanced_bits }: Values): string | undefined => {
	if (acquisition_type === undefined) return undefined;
	const argument = average_count ?? (enhanced_bits === undefined ? undefined : Number(enhanced_bits).toFixed(1));
	return `${TYPE} ${acquisition_type}${argument === undefined ? '' : `,${argument}`}`;
};

// p. 43 names the SDS2000X Plus and no other model: another model is refused rather than asked, because an
// undocumented query blocks for the whole timeout and takes the connection with it.
function requireResolution(scope: ScpiScope): void {
	const model = scope.identity?.model ?? '';
	if (!probesResolution(model)) {
		throw new UnsupportedError(`ADC resolution is available on SDS2000X Plus models, not ${model}`);
	}
}

const readType = async (session: ScpiSession): Promise<Values> => decodeType(await session.query(`${TYPE}?`));

export const acquisitionTools = [
	tool({
		name: 'get_acquisition',
		description:
			'Read the acquisition mode, capture rate, interpolation, sequence settings, acquisition type, memory management, memory depth, sample rate, acquisition count and sampled points. ADC resolution is included on SDS2000X Plus models. Use get_timebase for horizontal settings.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => ({
				...(probesResolution(scope.identity?.model ?? '') && {
					resolution: await scope.readResolution(session),
				}),
				...(await readback(session, all)),
				...(await readType(session)),
				acquisitions: counted('acquisitions')(await session.query(`${NUMACQ}?`)),
				points: asQuantity(await session.query(`${POINTS}?`)),
			})),
	}),
	tool({
		name: 'configure_acquisition',
		description:
			'Set the acquisition mode, capture rate, interpolation, sequence settings, acquisition type and memory settings, then read back the requested values. Average count applies to Average acquisition and enhanced bits applies to Enhanced Resolution. Neither acquisition type is available in sequence mode. ADC resolution is available on SDS2000X Plus models. Values adjusted by the scope are returned with a warning.',
		input: z
			.strictObject(inputs(all))
			.refine(
				({ acquisition_type, average_count }: Values) => average_count === undefined || acquisition_type === 'AVERage',
				{
					message: 'average_count requires acquisition_type Average. Remove it or select Average',
					path: ['average_count'],
				},
			)
			.refine(
				({ acquisition_type, enhanced_bits }: Values) => enhanced_bits === undefined || acquisition_type === 'ERES',
				{
					message:
						'enhanced_bits requires acquisition_type Enhanced Resolution. Remove it or select Enhanced Resolution',
					path: ['enhanced_bits'],
				},
			)
			.refine(
				({ acquisition_type, sequence }: Values) =>
					sequence !== true || (acquisition_type !== 'AVERage' && acquisition_type !== 'ERES'),
				{
					message:
						'Sequence mode does not support Average or Enhanced Resolution acquisition. Disable sequence mode or choose another acquisition type',
					path: ['acquisition_type'],
				},
			),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(
				...settings([resolution], input),
				...settings(before, input),
				typeCommand(input),
				...settings(after, input),
			);
			return scope.execute(async (session) => {
				const wroteResolution = input.resolution !== undefined;
				if (wroteResolution) requireResolution(scope);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(await readback(session, applied(all, input))),
					...(input.acquisition_type === undefined ? {} : await readType(session)),
				};
				compare(scope, all, input, state);
				if (wroteResolution) {
					const read = await scope.readResolution(session);
					state.resolution = read;
					if (parseState(read.raw, resolutions) !== input.resolution) {
						scope.warn(`resolution was set to ${input.resolution} but the scope reports ${JSON.stringify(read.raw)}`);
					}
				}
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'clear_sweeps',
		description:
			'Clear the accumulated sweeps and restart the acquisition. Averaging, persistence, statistics and the acquisition count start over and cannot be restored. The command has no query form.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command(CSWEEP);
				return { commands: [CSWEEP] };
			}),
	}),
];
