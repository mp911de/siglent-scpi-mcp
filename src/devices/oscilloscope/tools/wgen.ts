import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asState, parseKeyValues, parseQuantity, parseState, stripHeader } from '../../../scpi/values.ts';
import { clamped, compare, flag, inputs, type Param, pairs, param, type Values } from '../../../tools/params.ts';
import type { Scope } from '../scope.ts';
import { destructive, readOnly, tool } from './define.ts';
import { hertz, timeValue, volts } from './schema.ts';

const types = [
	'SINE',
	'SQUARE',
	'RAMP',
	'PULSE',
	'DC',
	'NOISE',
	'CARDIAC',
	'GAUS_PULSE',
	'EXP_RISE',
	'EXP_FALL',
	'ARB1',
	'ARB2',
	'ARB3',
	'ARB4',
] as const;
const stores = ['DEBUG', 'RELEASE'] as const;
const loads = ['HZ', '50'] as const;
const states = ['ON', 'OFF'] as const;
const locations = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'] as const;

type Type = (typeof types)[number];

const canonical = (value: string): string =>
	value.replace(/(hz|v|s)$/i, (unit) => (unit.length > 1 ? 'Hz' : unit.toUpperCase()));

const magnitude = (value: string): number | undefined => parseQuantity(canonical(value))?.value;

// Read-back keeps the scope's own spelling in raw and parses a unit the guide writes as 'Hz' but a scope may answer
// in any case.
const quantity = (raw: string) => {
	const parsed = parseQuantity(canonical(raw));
	return parsed ? { ...parsed, raw } : { raw };
};

const ranged = (schema: z.ZodType<string>, min: number, max: number, hint: string) =>
	schema.refine((value) => {
		const size = magnitude(value);
		return size !== undefined && size >= min && size <= max;
	}, hint);

const percent = (min: number, max: number) => z.number().min(min).max(max);

// The type row is the discriminator, so its schema is declared with the variants below; the row carries the mnemonic,
// the description and the parse. OUTP is kept out of the table because it is sent on its own, last of all.
const outputState = flag(
	'output',
	'OUTP',
	'Generator output on or off. On drives the configured signal onto the WGEN BNC.',
	(raw) => parseState(raw, states) === 'ON',
);

const params: Param[] = [
	param('type', 'WVTP', z.enum(types), 'basic waveform type', (raw) => asState(raw, types)),
	clamped(
		'frequency',
		'FREQ',
		ranged(hertz, 1e-6, 25e6, "frequency, 0.000001Hz to 25MHz, e.g. '10KHz'"),
		'output frequency, 0.000001Hz to 25MHz',
		quantity,
		1e-6,
	),
	clamped(
		'amplitude',
		'AMPL',
		ranged(volts, 0.004, 6, "amplitude, 0.004V to 6V, e.g. '2.5V'"),
		'peak-to-peak amplitude, 0.004V to 6V',
		quantity,
		1e-4,
	),
	clamped(
		'offset',
		'OFST',
		ranged(volts, -3, 3, "offset, -(6-amplitude)/2 to (6-amplitude)/2 volts, e.g. '500mV'"),
		'offset, -(6-amplitude)/2 to (6-amplitude)/2 volts',
		quantity,
		1e-4,
	),
	clamped(
		'dc_offset',
		'DCOFST',
		ranged(volts, -3, 3, "DC level, -3V to 3V, e.g. '1.5V'"),
		'DC level, -3V to 3V',
		quantity,
		1e-4,
	),
	clamped('duty', 'DUTY', percent(20, 80), 'duty cycle in percent, 20 to 80', quantity, 0.05),
	clamped('symmetry', 'SYMM', percent(0, 100), 'symmetry in percent, 0 to 100', quantity, 0.05),
	clamped(
		'width',
		'WIDTH',
		ranged(timeValue, 48e-9, 1e-3, "pulse width, 0.000000048s to 0.001s, e.g. '10US'"),
		'pulse width, 48ns to 1ms',
		quantity,
		1e-12,
	),
	clamped(
		'stdev',
		'STDEV',
		ranged(volts, 0.0003, 0.45, "standard deviation, 0.0003V to 0.45V, e.g. '200mV'"),
		'noise standard deviation, 0.0003V to 0.45V',
		quantity,
		1e-6,
	),
	clamped(
		'mean',
		'MEAN',
		ranged(volts, -3, 3, "mean, -(0.45-stdev)*20/3 to (0.45-stdev)*20/3 volts, e.g. '1V'"),
		'noise mean, -(0.45-stdev)*20/3 to (0.45-stdev)*20/3 volts',
		quantity,
		1e-6,
	),
	param('load', 'LOAD', z.enum(loads), 'output load: HZ high impedance or 50 ohm', (raw) => asState(raw, loads)),
];

const readable = [outputState, ...params];

// One variant per set of parameters the guide declares valid for a waveform type (pp. 279-280). OFST is excluded for
// NOISE only, which leaves it valid for DC next to DCOFST.
const variant = (group: Type[], fields: string[]) =>
	z.strictObject({
		type: z.enum(group).describe('Basic waveform type. Determines which other fields are valid.'),
		...inputs(params.filter(({ name }) => fields.includes(name))),
	});

const basic = ['frequency', 'amplitude', 'offset'];

const level = (value: unknown): number | undefined => (typeof value === 'string' ? magnitude(value) : undefined);

const fits = (values: Values, field: string, other: string, bound: (value: number) => number): boolean => {
	const [wanted, limit] = [level(values[field]), level(values[other])];
	return wanted === undefined || limit === undefined || Math.abs(wanted) <= bound(limit);
};

const waveform = z
	.discriminatedUnion('type', [
		variant(['SINE', 'CARDIAC', 'GAUS_PULSE', 'EXP_RISE', 'EXP_FALL', 'ARB1', 'ARB2', 'ARB3', 'ARB4'], basic),
		variant(['SQUARE'], [...basic, 'duty']),
		variant(['RAMP'], [...basic, 'symmetry']),
		variant(['PULSE'], [...basic, 'width']),
		variant(['DC'], ['offset', 'dc_offset']),
		variant(['NOISE'], ['stdev', 'mean']),
	])
	.refine((values: Values) => fits(values, 'offset', 'amplitude', (amplitude) => (6 - amplitude) / 2), {
		message:
			'offset is outside the range allowed by amplitude. Choose a value between -(6-amplitude)/2 and (6-amplitude)/2 volts.',
		path: ['offset'],
	})
	.refine((values: Values) => fits(values, 'mean', 'stdev', (stdev) => ((0.45 - stdev) * 20) / 3), {
		message:
			'mean is outside the range allowed by stdev. Choose a value between -(0.45-stdev)*20/3 and (0.45-stdev)*20/3 volts.',
		path: ['mean'],
	});

interface Request {
	waveform?: Values;
	load?: (typeof loads)[number];
	arbitrary_index?: number;
	output?: boolean;
	confirm_output_enable?: true;
}

// The guide's own example sends the duty and the symmetry with a percent sign (p. 280).
function wire({ waveform: shape, load }: Request): Values {
	const { duty, symmetry, ...rest } = shape ?? {};
	return {
		...rest,
		...(duty !== undefined && { duty: `${duty}%` }),
		...(symmetry !== undefined && { symmetry: `${symmetry}%` }),
		...(load !== undefined && { load }),
	};
}

// The syntax table and the query parameter list name the type WVTP (p. 279), all three examples send TYPE
// (pp. 280-281) and the prose has a third spelling, WVPT. WVTP goes out first; a scope that answers in the example's
// spelling is understood here and configured again in it.
const spellings = ['WVTP', 'TYPE'] as const;
type Spelling = (typeof spellings)[number];

const spelled = (spelling: Spelling): Param[] =>
	params.map((row) => (row.name === 'type' ? { ...row, mnemonic: spelling } : row));

const spellingOf = ({ raw }: Values): Spelling | undefined => {
	const fields = parseKeyValues(String(raw));
	return spellings.find((name) => fields[name] !== undefined);
};

function decode(raw: string): Values {
	const fields = parseKeyValues(raw);
	const state: Values = { raw };
	for (const row of readable) {
		const value = row.name === 'type' ? spellings.map((name) => fields[name]).find(Boolean) : fields[row.mnemonic];
		if (value !== undefined && row.parse) state[row.name] = row.parse(value);
	}
	return state;
}

const readState = async (session: ScpiSession): Promise<Values> => decode(await session.query('WGEN? ALL'));

async function readProduct(session: ScpiSession) {
	const [model, band] = [await session.query('PROD? MODEL'), await session.query('PROD? BAND')];
	return {
		model: parseKeyValues(model).MODEL ?? stripHeader(model),
		bandwidth: quantity(parseKeyValues(band).BAND ?? stripHeader(band)),
		raw: { model, bandwidth: band },
	};
}

async function readStore(session: ScpiSession, store: (typeof stores)[number]) {
	const raw = await session.query(`STL? ${store}`);
	const entries = Object.entries(parseKeyValues(raw)).map(([index, name]) => ({ index, name }));
	return { store, entries, raw };
}

async function readArbitrary(session: ScpiSession, wanted: readonly string[]) {
	const waveforms = [];
	for (const index of wanted) {
		const raw = await session.query(`WVPR? ${index}`);
		const fields = parseKeyValues(raw);
		waveforms.push({
			location: fields.POS ?? index,
			name: fields.WVNM,
			frequency: quantity(fields.FREQ ?? ''),
			amplitude: quantity(fields.AMPL ?? ''),
			offset: quantity(fields.OFST ?? ''),
			raw,
		});
	}
	return waveforms;
}

// A signal on the BNC reaches whatever is wired to it the moment a command lands, so every change to a running
// generator needs the same acknowledgement as switching it on. A request that switches the output off does that
// first (see the command order below) and needs none.
async function guardLiveOutput(session: ScpiSession, scope: Scope, input: Request): Promise<void> {
	if (input.confirm_output_enable === true || input.output === false) return;
	const raw = await session.query('WGEN? OUTP');
	const on = parseState(parseKeyValues(raw).OUTP ?? stripHeader(raw), states);
	if (on === 'OFF') return;
	if (on === undefined) {
		scope.warn(
			`The generator output response ${JSON.stringify(raw)} was not recognized. The generator was reconfigured without knowing whether the output was active.`,
		);
		return;
	}
	throw new Error(
		'The generator output is already on. Set confirm_output_enable to true to change the live signal, or set output to false first.',
	);
}

export const wgenTools = [
	tool({
		name: 'get_waveform_generator',
		description:
			'Read the built-in waveform generator model, frequency limit, output settings, and stored arbitrary waveforms. Arbitrary-waveform selection has no query form. AWG option support is reported because it cannot be inferred from the model name.',
		input: z.object({
			store: z
				.enum(stores)
				.default('DEBUG')
				.describe('Debug lists built-in and user waveforms. Release lists only user waveforms.'),
			waveforms: z
				.array(z.enum(locations))
				.optional()
				.describe('Stored waveform locations to read. Defaults to non-empty entries.'),
		}),
		annotations: readOnly,
		handler: ({ store, waveforms }, scope) =>
			scope.execute(async (session) => {
				scope.require('awg');
				const product = await readProduct(session);
				const state = await readState(session);
				const stored = await readStore(session, store);
				const wanted =
					waveforms ??
					stored.entries.filter(({ index, name }) => name !== 'EMPTY' && /^M\d$/.test(index)).map(({ index }) => index);
				return { product, state, stored, arbitrary: await readArbitrary(session, wanted), write_only: ['ARWV'] };
			}),
	}),
	tool({
		name: 'configure_waveform_generator',
		description:
			'Configure the built-in waveform generator and switch its output on or off. Waveform parameters must match the selected type. Enabling the output or changing a live signal drives the connected circuit and requires `confirm_output_enable: true`. Disabling the output requires no confirmation. Waveform type compatibility is unverified on some models.',
		input: z
			.object({
				waveform: waveform
					.optional()
					.describe('Waveform type and its parameters, for example { type: "SQUARE", duty: 45 }.'),
				load: z.enum(loads).optional().describe('Output load. HZ means high impedance. 50 means 50 ohms.'),
				arbitrary_index: z.int().min(0).max(9).optional().describe('Stored arbitrary waveform 0-9.'),
				output: z.boolean().optional().describe('Turn the generator output on or off.'),
				confirm_output_enable: z
					.literal(true)
					.optional()
					.describe('Explicit acknowledgement that the WGEN BNC drives a signal into the connected circuit'),
			})
			.refine(({ output, confirm_output_enable }) => output !== true || confirm_output_enable === true, {
				message: 'Enabling the generator drives a signal onto the BNC. Set confirm_output_enable to true.',
				path: ['confirm_output_enable'],
			}),
		annotations: destructive,
		handler: (input: Request, scope) =>
			scope.execute(async (session) => {
				scope.require('awg');
				const values = wire(input);
				const line = (spelling: Spelling) => pairs(spelled(spelling), values);
				const commands = plan(
					input.output === false && 'WGEN OUTP,OFF',
					input.arbitrary_index !== undefined && `ARWV INDEX,${input.arbitrary_index}`,
					line('WVTP') !== '' && `WGEN ${line('WVTP')}`,
					input.output === true && 'WGEN OUTP,ON',
				);
				await guardLiveOutput(session, scope, input);
				for (const command of commands) await session.command(command);
				let state = await readState(session);
				let spelling = values.type === undefined ? undefined : spellingOf(state);
				if (spelling === 'TYPE') {
					scope.warn(
						'This model uses an alternate waveform-type spelling. The configuration was sent again with that spelling.',
					);
					commands.push(`WGEN ${line('TYPE')}`);
					await session.command(`WGEN ${line('TYPE')}`);
					state = await readState(session);
					spelling = spellingOf(state);
				}
				if (values.type !== undefined && spelling === undefined) {
					scope.warn(
						'The waveform-type spelling used by this model is unknown. The requested type could not be verified.',
					);
				}
				compare(scope, readable, { ...values, ...(input.output !== undefined && { output: input.output }) }, state);
				return {
					commands,
					state,
					...(spelling && { type_parameter: spelling }),
					...(input.output === true && {
						output_enabled: {
							confirmed: true,
							type: state.type,
							amplitude: state.amplitude,
							offset: state.offset,
							load: state.load,
						},
					}),
				};
			}),
	}),
];
