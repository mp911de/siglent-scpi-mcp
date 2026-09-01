import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import {
	asState,
	isOn,
	parseFields,
	parseKeyValues,
	parseQuantity,
	parseState,
	type Quantity,
	stripHeader,
} from '../../../scpi/values.ts';
import { compare, flag, inputs, type Param, pairs, param, type Values } from '../../../tools/params.ts';
import type { ScpiScope } from '../scope.ts';
import { destructive, readOnly, tool } from './define.ts';

// "The WGEN commands are the same as that of Siglent SDG series, so the format is not consistent with other groups"
// (p. 699): these sections print no leading colon, and the four addressed ones carry the generator channel as a
// prefix instead. <channel> := {C1} on every one of them, because "SAG and the built-in waveform generator only
// support one output channel", so C1 is the whole documented set rather than a numbered node.
const ARBITRARY = 'C1:ARbWaVe';
const BASIC = 'C1:BaSic_WaVe';
const OUTPUT = 'C1:OUTPut';
const STORE = 'SToreList';
const SYNC = 'C1:SYNC';
const PROTECTION = 'VOLTPRT';

const types = ['SINE', 'SQUARE', 'RAMP', 'PULSE', 'NOISE', 'ARB', 'DC', 'PRBS', 'IQ'] as const;
type Type = (typeof types)[number];

const loads = ['50', 'HZ'] as const;
const stores = ['BUILDIN', 'USER'] as const;
const states = ['ON', 'OFF'] as const;

// The guide bounds none of the wave parameters ("refer to the data sheet for the range of valid values", p. 702), so
// each row carries a sanity bound wide enough for any generator the guide lists and the instrument's own limit comes
// back as a read-back warning.
const hertz = z.number().positive().max(1e9);
const seconds = z.number().positive().max(1e3);
const volts = z.number().min(-1000).max(1000);
const percent = z.number().min(0).max(100);

// The generator answers its units in the SDG spelling the guide prints (FRQ,100HZ, PERI,0.01S), which the shared
// parser takes in the SI one, and the scope's own spelling survives in raw.
const canonical = (raw: string): string =>
	raw.replace(/(hz|v|s)$/i, (unit) => (unit.length > 1 ? 'Hz' : unit.toUpperCase()));

const quantity = (raw: string): Quantity | { raw: string } => {
	const parsed = parseQuantity(canonical(raw));
	return parsed ? { ...parsed, raw } : { raw };
};

const wave: Param[] = [
	param('type', 'WVTP', z.enum(types), 'Basic waveform type. Left out, the generator keeps the type it holds', (raw) =>
		asState(raw, types),
	),
	param('frequency', 'FRQ', hertz, 'Frequency in Hz', quantity),
	param('period', 'PERI', seconds, 'Period in seconds, the reciprocal of the frequency', quantity),
	param('amplitude', 'AMP', volts, 'Peak-to-peak amplitude in volts', quantity),
	param('offset', 'OFST', volts, 'Offset in volts', quantity),
	param('symmetry', 'SYM', percent, 'Symmetry of a ramp in percent, 0 to 100', quantity),
	param('duty', 'DUTY', percent, 'Duty cycle in percent, 0 to 100. It depends on the frequency', quantity),
	param('deviation', 'STDEV', volts, 'Standard deviation of noise in volts', quantity),
	param('mean', 'MEAN', volts, 'Mean of noise in volts', quantity),
	param('width', 'WIDTH', seconds, 'Positive pulse width in seconds', quantity),
];

const composite: Param[] = [
	flag('output', 'OUTP', 'Whether the front-panel generator output drives the circuit connected to it'),
	param('load', 'LOAD', z.enum(loads), 'Output load in ohms. HZ is high impedance', (raw) => asState(raw, loads)),
	flag('sync', 'SYNC', 'Whether the synchronization output is on'),
	flag('voltage_protection', 'VOLTPRT', 'Whether over-voltage protection is on'),
];

const rows = [...wave, ...composite];

const except = (...blocked: Type[]): Type[] => types.filter((type) => !blocked.includes(type));

// The "not valid when" and "only settable when" notes of the parameter table (pp. 702-703), read as the set of
// waveform types each row applies to. A request that names no type leaves the current one in force, and the guide
// gives no query that answers before the write, so nothing is checked then.
const validFor: Record<string, readonly Type[]> = {
	frequency: except('NOISE', 'DC'),
	period: except('NOISE', 'DC'),
	amplitude: except('NOISE', 'DC'),
	offset: except('NOISE'),
	symmetry: ['RAMP'],
	duty: ['SQUARE', 'PULSE'],
	deviation: ['NOISE'],
	mean: ['NOISE'],
	width: ['PULSE'],
};

const OPTION =
	'The waveform generator is an option (built-in generator or SAG1021I, licensed as Option FG) and its availability cannot be determined from the model identity';

// The leading field of a composite reply: ON or OFF, and an answer that is neither keeps its raw text rather than
// being reported as off.
const enabled = (field: string | undefined, raw: string): boolean | { raw: string } => {
	const state = parseState(field ?? '', states);
	return state === undefined ? { raw } : state === 'ON';
};

// One query answers every wave parameter at once, so the reply is split rather than asked for row by row, and the
// parameters this driver does not type (the example prints HLEV, LLEV and PHSE) survive in raw.
function readWave(raw: string): Values {
	const fields = parseKeyValues(raw);
	const state: Values = {};
	for (const row of wave) {
		const value = fields[row.mnemonic];
		if (value !== undefined && row.parse) state[row.name] = row.parse(value);
	}
	return state;
}

const readOutput = (raw: string): Values => ({
	output: enabled(parseFields(raw)[0], raw),
	load: asState(parseKeyValues(raw, 1).LOAD ?? '', loads),
	polarity: parseKeyValues(raw, 1).PLRT,
});

const readSync = (raw: string): Values => ({
	sync: enabled(parseFields(raw)[0], raw),
	sync_source: parseKeyValues(raw, 1).TYPE,
});

const readArbitrary = (raw: string): Values => {
	const fields = parseKeyValues(raw);
	return { index: fields.INDEX, name: fields.NAME };
};

// The list runs to hundreds of entries on the models the guide prints it for, so it is returned as pairs rather than
// as the raw line it arrives in.
async function readStore(session: ScpiSession, store?: string): Promise<Values> {
	const raw = await session.query(store === undefined ? `${STORE}?` : `${STORE}? ${store}`);
	if (stripHeader(raw).toUpperCase() === 'EMPTY') return { store, empty: true };
	return { store, entries: Object.entries(parseKeyValues(raw)).map(([index, name]) => ({ index, name })) };
}

const line = (output: boolean | undefined, load: unknown): string =>
	`${OUTPUT} ${[output === undefined ? undefined : onOff(output), load !== undefined && `LOAD,${load}`]
		.filter(Boolean)
		.join(',')}`;

// A signal on the BNC reaches whatever is wired to it the moment a command lands, so changing a running generator
// needs the same acknowledgement as switching it on. A request that switches the output off does that first and
// needs none.
async function guardLiveOutput(session: ScpiSession, scope: ScpiScope, input: Values): Promise<void> {
	if (input.confirm_output_enable === true || input.output === false) return;
	const raw = await session.query(`${OUTPUT}?`);
	const { output } = readOutput(raw);
	if (output === false) return;
	if (output !== true) {
		scope.warn(
			`The generator output answered ${JSON.stringify(stripHeader(raw))} rather than ON or OFF, so it was reconfigured without knowing whether the output was live`,
		);
		return;
	}
	throw new Error(
		'The generator output is already on, so this request would change a live signal. Set confirm_output_enable to true, or switch the output off in the same call.',
	);
}

const arbitrary = {
	index: z.number().int().min(0).max(999),
	// The names of the built-in table are letters, digits and underscores; the grammar excludes every character with
	// a meaning in the command line.
	name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use 1 to 32 letters, digits, underscores, or hyphens'),
};

export const wgenTools = [
	tool({
		name: 'get_waveform_generator',
		description:
			'Read the built-in waveform generator: the wave it is set to, the output state and load, the arbitrary waveform selected, the synchronization output, over-voltage protection and the stored waveform list. Generator availability cannot be determined from the model identity.',
		input: z.strictObject({
			store: z
				.enum(stores)
				.optional()
				.describe(
					'Restrict the stored waveform list to the built-in or the user waveforms. Both are listed by default',
				),
		}),
		annotations: readOnly,
		handler: ({ store }, scope) =>
			scope.execute(async (session) => {
				scope.warn(`${OPTION}, so this read assumes it does`);
				const answers = {
					waveform: await session.query(`${BASIC}?`),
					output: await session.query(`${OUTPUT}?`),
					arbitrary: await session.query(`${ARBITRARY}?`),
					sync: await session.query(`${SYNC}?`),
				};
				return {
					waveform: { ...readWave(answers.waveform), raw: answers.waveform },
					output: { ...readOutput(answers.output), raw: answers.output },
					arbitrary: { ...readArbitrary(answers.arbitrary), raw: answers.arbitrary },
					sync: { ...readSync(answers.sync), raw: answers.sync },
					voltage_protection: isOn(await session.query(`${PROTECTION}?`)),
					stored: await readStore(session, store),
				};
			}),
	}),
	tool({
		name: 'configure_waveform_generator',
		description:
			'Set the built-in waveform generator and switch its output on or off. Enabling the output, or changing anything while it is already on, drives the connected circuit and requires confirm_output_enable: true. Switching the output off requires no acknowledgement and is sent first. Turning voltage_protection off removes the over-voltage protection of the output, which is the consequential direction of that setting. Generator availability cannot be determined from the model identity.',
		input: z
			.strictObject({
				...inputs(rows),
				arbitrary_index: arbitrary.index
					.optional()
					.describe('Arbitrary waveform to select by index. get_waveform_generator lists the indexes this model holds'),
				arbitrary_name: arbitrary.name
					.optional()
					.describe('Arbitrary waveform to select by name. get_waveform_generator lists the names this model holds'),
				confirm_output_enable: z
					.literal(true)
					.optional()
					.describe('Explicit acknowledgement that the generator output drives the circuit connected to it'),
			})
			.refine((input: Values) => input.output !== true || input.confirm_output_enable === true, {
				message: 'Enabling the output drives a signal into the connected circuit. Set confirm_output_enable to true.',
				path: ['confirm_output_enable'],
			})
			.refine((input: Values) => input.arbitrary_index === undefined || input.arbitrary_name === undefined, {
				message: 'Select an arbitrary waveform by index or by name, not both',
				path: ['arbitrary_name'],
			})
			.superRefine((input: Values, ctx) => {
				const type = input.type;
				if (typeof type !== 'string') return;
				for (const [name, allowed] of Object.entries(validFor)) {
					if (input[name] !== undefined && !allowed.includes(type as Type)) {
						ctx.addIssue({
							code: 'custom',
							message: `${name} is not settable while the waveform type is ${type}. Use one of ${allowed.join(', ')}`,
							path: [name],
						});
					}
				}
			}),
		annotations: destructive,
		handler: (input: Values, scope) => {
			const off = input.output === false;
			const parameters = pairs(wave, input);
			const commands = plan(
				off && line(false, input.load),
				input.arbitrary_index !== undefined && `${ARBITRARY} INDEX,${input.arbitrary_index}`,
				input.arbitrary_name !== undefined && `${ARBITRARY} NAME,${input.arbitrary_name}`,
				parameters !== '' && `${BASIC} ${parameters}`,
				input.sync !== undefined && `${SYNC} ${onOff(input.sync === true)}`,
				input.voltage_protection !== undefined && `${PROTECTION} ${onOff(input.voltage_protection === true)}`,
				!off &&
					(input.output === true || input.load !== undefined) &&
					line(input.output as boolean | undefined, input.load),
			);
			return scope.execute(async (session) => {
				scope.warn(`${OPTION}, so this request assumes it does`);
				if (input.voltage_protection === false) {
					scope.warn(
						'Over-voltage protection is now off, so the output is no longer protected against a voltage fed back into it',
					);
				}
				await guardLiveOutput(session, scope, input);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(parameters !== '' && readWave(await session.query(`${BASIC}?`))),
					...((input.output !== undefined || input.load !== undefined) &&
						readOutput(await session.query(`${OUTPUT}?`))),
					...(input.sync !== undefined && readSync(await session.query(`${SYNC}?`))),
					...(input.voltage_protection !== undefined && {
						voltage_protection: isOn(await session.query(`${PROTECTION}?`)),
					}),
					...((input.arbitrary_index !== undefined || input.arbitrary_name !== undefined) && {
						arbitrary: readArbitrary(await session.query(`${ARBITRARY}?`)),
					}),
				};
				compare(scope, rows, input, state);
				return { commands, state };
			});
		},
	}),
];
