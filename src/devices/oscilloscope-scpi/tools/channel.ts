import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import { ScpiError } from '../../../scpi/connection.ts';
import { asQuantity, asState, isOn, quoted, unquote } from '../../../scpi/values.ts';
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
} from '../../../tools/params.ts';
import { type Channel, channels } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const references = ['OFFSet', 'POSition'] as const;
const bandwidths = ['FULL', '20M', '200M'] as const;
const couplings = ['DC', 'AC', 'GND'] as const;
const impedances = ['ONEMeg', 'FIFTy'] as const;
const units = ['V', 'A'] as const;

const SKEW = 100e-9;
const PICOSECOND = 1e-12;
const MICROVOLT = 1e-6;

// The guide bounds only the probe factor ([1E-6, 1E6], p. 57) and the skew ([-1E-7, 1E-7], p. 59). It points at the
// data sheet for the scale (p. 58) and bounds the offset by the scale in force (p. 56), both of which the probe
// factor multiplies, so these keep a value inside what a vertical setting can mean at all and leave the rest to the
// scope, which moves what it cannot take to the nearest value it can and comes back as a warning.
const factor = z.number().min(1e-6).max(1e6);
const voltsPerDiv = z.number().min(MICROVOLT).max(1e6);
const offsetVolts = z.number().min(-1e6).max(1e6);

// Quoted on the wire, and the scope uppercases every label it stores, so only uppercase goes out.
const labelText = z
	.string()
	.max(20)
	.regex(/^[A-Z0-9 _+.-]*$/, 'up to 20 of A-Z, 0-9, space, underscore, plus, dot or hyphen');

const volts = (name: string, mnemonic: string, schema: z.ZodType, what: string): Param => ({
	...clamped(name, mnemonic, schema, what, asQuantity, MICROVOLT),
	wire: nr3,
});

// Guide order of the writes: the switch and the unit first, then the impedance and the probe factor, which bound and
// multiply the scale, then the scale, which bounds the offset. The label text before the label that shows it.
const params: Param[] = [
	flag('trace', ':CHANnel<n>:SWITch', 'the channel itself, the physical input switch', isOn),
	param(
		'unit',
		':CHANnel<n>:UNIT',
		z.enum(units),
		'unit of the input signal, which also relabels the measurements, the cursor values, the sensitivity and the trigger level',
		(raw) => asState(raw, units),
	),
	param(
		'impedance',
		':CHANnel<n>:IMPedance',
		z.enum(impedances),
		'Input impedance. One Megohm is 1 MOhm. Fifty Ohm limits volts_per_div to less than 1 V',
		(raw) => asState(raw, impedances),
	),
	{
		...clamped(
			'probe_attenuation',
			':CHANnel<n>:PROBe',
			factor,
			'Probe attenuation factor. It scales volts_per_div, offset, measurements and trigger levels without changing input sensitivity',
			asQuantity,
			1e-6,
		),
		wire: (value) => `VALue,${nr3(value)}`,
	},
	volts(
		'volts_per_div',
		':CHANnel<n>:SCALe',
		voltsPerDiv,
		'Vertical sensitivity in volts per division, multiplied by probe_attenuation',
	),
	volts(
		'offset',
		':CHANnel<n>:OFFSet',
		offsetVolts,
		'vertical offset in volts, whose legal range follows volts_per_div',
	),
	param('coupling', ':CHANnel<n>:COUPling', z.enum(couplings), 'Input coupling: DC, AC or ground', (raw) =>
		asState(raw, couplings),
	),
	param(
		'bandwidth_limit',
		':CHANnel<n>:BWLimit',
		z.enum(bandwidths),
		'low-pass filter: FULL is the full bandwidth, 20M and 200M limit it to approximately that many hertz',
		(raw) => asState(raw, bandwidths),
	),
	flag(
		'inverted',
		':CHANnel<n>:INVert',
		'mathematical inversion of the trace, which does not change the polarity of the input against ground',
		isOn,
	),
	{
		...clamped(
			'skew',
			':CHANnel<n>:SKEW',
			z.number().min(-SKEW).max(SKEW),
			'channel-to-channel skew in seconds, -100 ns to 100 ns',
			asQuantity,
			PICOSECOND,
		),
		wire: nr3,
	},
	{
		...param(
			'label_text',
			':CHANnel<n>:LABel:TEXT',
			labelText,
			'Label text, up to 20 characters. The scope stores labels in uppercase',
			unquote,
		),
		wire: quoted,
	},
	flag('label', ':CHANnel<n>:LABel', 'the label on screen', isOn),
	flag(
		'visible',
		':CHANnel<n>:VISible',
		'drawing the waveform, which leaves the channel switched on, unlike trace',
		isOn,
	),
];

const reference = param(
	'vertical_reference',
	':CHANnel:REFerence',
	z.enum(references),
	'What stays fixed while the vertical scale changes. Offset expands around the display X axis. Position expands around the ground marker. This setting is shared by every channel',
	(raw) => asState(raw, references),
);

const at = (channel: Channel, rows: readonly Param[]): Param[] =>
	rows.map((row) => ({ ...row, mnemonic: row.mnemonic.replace('<n>', channel.slice(1)) }));

const source = z.enum(channels);

export const target = {
	source: source.optional().describe('Analog channel C1-C4. channel is accepted as an alias'),
	channel: source.optional().describe('Alias of source'),
};

export function sourceOf({ source: named, channel }: { source?: Channel; channel?: Channel }): Channel {
	const chosen = named ?? channel;
	if (!chosen) throw new ScpiError('An analog channel is required: pass source (or channel) as C1-C4');
	return chosen;
}

export const channelTools = [
	tool({
		name: 'get_channel',
		description:
			'Read the configuration of one analog channel C1-C4, including its input, scaling, coupling, bandwidth, inversion, skew, label and visibility. Also returns the vertical reference shared by all channels.',
		input: z.strictObject(target),
		annotations: readOnly,
		handler: (input, scope) => {
			const channel = sourceOf(input);
			return scope.execute(async (session) => {
				scope.requireChannel(channel);
				return {
					channel,
					...(await readback(session, at(channel, params))),
					...(await readback(session, [reference])),
				};
			});
		},
	}),
	tool({
		name: 'configure_channel',
		description:
			'Set one analog channel C1-C4 and read back the requested settings. Fifty Ohm impedance limits volts_per_div to less than 1 V. Values adjusted by the scope are returned with a warning.',
		input: z.strictObject({ ...target, ...inputs([reference]), ...inputs(params) }),
		annotations: mutating,
		handler: (input, scope) => {
			const channel = sourceOf(input);
			const commands = plan(...settings([reference], input), ...settings(at(channel, params), input));
			return scope.execute(async (session) => {
				scope.requireChannel(channel);
				for (const command of commands) await session.command(command);
				const state = {
					channel,
					...(await readback(session, at(channel, applied(params, input)))),
					...(await readback(session, applied([reference], input))),
				};
				compare(scope, [...params, reference], input, state);
				return { commands, state };
			});
		},
	}),
];
