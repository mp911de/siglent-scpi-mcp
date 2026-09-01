import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { stripHeader } from '../../../scpi/values.ts';
import type { Values } from '../../../tools/params.ts';
import { reading, type ScpiScope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

// The METEr sections print no leading colon either, and the guide brackets an optional node in two places. Its own
// worked examples keep the CONFigure and MEASure voltage node (CONF:VOLT:AC 60) and drop the SENSe prefix
// (VOLT:AC:NULL ON), so the wire form keeps the one and drops the other. The transcribed identifiers stay verbatim.
const wire = (id: string): string => (id.startsWith('[') ? id.replace(/^\[[^\]]*\]/, '') : id.replace(/[[\]]/g, ''));

const METER = 'MMETer';
const READ = 'READ';
const PRESENT = 'CONFigure';

// The four the CONFigure sections add to every fixed range (pp. 713-718). The MEASure sections print a narrower set
// per function, and neither is guessed from the other.
const automatic = ['AUTO', 'MIN', 'MAX', 'DEF'] as const;
const currents = ['60mA', '600mA', '6A', '10A'] as const;
const resistances = ['600', '6k', '60k', '600k', '6M', '60M'] as const;
const voltages = ['60mV', '600mV', '6V', '60V', '600V'] as const;

// The voltage tables name the model each range belongs to: the SHS800X stops at 600V, the SHS1000X adds 750V for AC
// and 1000V for DC (pp. 716-717, 725-726). Nothing is refused on it, because the range is written and never read
// back; a range the guide prints for the other handheld warns instead.
const extended: Record<string, string> = { '750V': 'SHS1000X', '1000V': 'SHS1000X' };

interface Measurement {
	code: string;
	configure: string;
	measure: string;
	relative?: string;
	select?: string;
	units?: readonly string[];
	ranges?: readonly string[];
	measured?: readonly string[];
}

const voltage = (extra: string) => ({
	units: ['MV', 'V'],
	ranges: [...voltages, extra, ...automatic],
	measured: [...voltages, extra],
});

const current = {
	units: ['MA', 'A'],
	ranges: [...currents, ...automatic],
	measured: [...currents, 'AUTO'],
};

const resistance = { ranges: [...resistances, ...automatic], measured: resistances };

// The METEr group in guide order, one row per measurement function with the sections that address it.
const functions: Record<string, Measurement> = {
	continuity: { code: 'CONTINUITY', configure: 'CONFigure:CONTinuity', measure: 'MEASure:CONTinuity' },
	current_ac: {
		code: 'ACI',
		configure: 'CONFigure:CURRent:AC',
		measure: 'MEASure:CURRent:AC',
		relative: '[SENSe:]CURRent:AC:NULL',
		select: '[SENSe:]CURRent:AC:SELEct',
		...current,
	},
	current_dc: {
		code: 'DCI',
		configure: 'CONFigure:CURRent:DC',
		measure: 'MEASure:CURRent:DC',
		relative: '[SENSe:]CURRent:DC:NULL',
		select: '[SENSe:]CURRent:DC:SELEct',
		...current,
	},
	diode: { code: 'DIODE', configure: 'CONFigure:DIODe', measure: 'MEASure:DIODe' },
	resistance: {
		code: 'RES',
		configure: 'CONFigure:RESistance',
		measure: 'MEASure:RESistance',
		relative: '[SENSe:]RESistance:NULL',
		...resistance,
	},
	voltage_ac: {
		code: 'ACV',
		configure: 'CONFigure[:VOLTage]:AC',
		measure: 'MEASure[:VOLTage]:AC',
		relative: '[SENSe:]VOLTage:AC:NULL',
		select: '[SENSe:]VOLTage:AC:SELEct',
		...voltage('750V'),
	},
	voltage_dc: {
		code: 'DCV',
		configure: 'CONFigure[:VOLTage]:DC',
		measure: 'MEASure[:VOLTage]:DC',
		relative: '[SENSe:]VOLTage:DC:NULL',
		select: '[SENSe:]VOLTage:DC:SELEct',
		...voltage('1000V'),
	},
	capacitance: {
		code: 'CAP',
		configure: 'CONFigure:CAPacitance',
		measure: 'MEASure:CAPacitance',
		relative: '[SENSe:]CAPacitance:NULL',
	},
};

const names = Object.keys(functions) as [string, ...string[]];
const named = (code: string): string | undefined =>
	names.find((name) => functions[name]?.code.toUpperCase() === code.toUpperCase());

const every = (key: 'ranges' | 'measured'): [string, ...string[]] =>
	[...new Set(Object.values(functions).flatMap((entry) => entry[key] ?? []))] as [string, ...string[]];

// p. 709 documents the whole group for the multimeter of the SHS800X/SHS1000X handhelds and no other model, so any
// other one is refused rather than asked: an undocumented query blocks for the whole timeout and takes the
// connection with it.
function requireMeter(scope: ScpiScope): void {
	if (!/^SHS/i.test(scope.identity?.model ?? '')) {
		throw new UnsupportedError(
			`The multimeter is available on SHS800X/SHS1000X handhelds, not ${scope.identity?.model}`,
		);
	}
}

const thousand = /^SHS1\d{3}X/i;

const warnExtended = (scope: ScpiScope, range: unknown): void => {
	const model = extended[String(range)];
	if (model && !thousand.test(scope.identity?.model ?? '')) {
		scope.warn(`The ${range} range is known only for ${model}. Support on ${scope.identity?.model} is unknown`);
	}
};

// "If the resistance is greater than 600 ohm, the instrument displays the word overload and returns 'Overload' from
// the remote interface" (p. 713): a documented answer rather than a reading that failed to parse.
function measured(scope: ScpiScope, raw: string): Values {
	if (/^overload$/i.test(stripHeader(raw))) return { overload: true, raw };
	return { value: reading(scope, 'The meter', raw, 'a reading out of range answers Overload instead') };
}

const rangeOf = (key: 'ranges' | 'measured') => (input: Values, ctx: z.RefinementCtx) => {
	const entry = functions[String(input.function)];
	if (input.range === undefined || !entry) return;
	const allowed = entry[key] ?? [];
	if (!allowed.includes(String(input.range))) {
		ctx.addIssue({
			code: 'custom',
			message:
				allowed.length === 0
					? `The ${input.function} measurement takes no range`
					: `${input.range} is not a documented ${input.function} range. Choose one of ${allowed.join(', ')}`,
			path: ['range'],
		});
	}
};

export const meterTools = [
	tool({
		name: 'read_meter',
		description:
			'Read the function the handheld multimeter is set to and the value it measures. Enter the meter with configure_meter first because its active state cannot be checked remotely. An out-of-range reading is returned as Overload. SHS800X and SHS1000X handhelds only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				requireMeter(scope);
				const present = await session.query(`${PRESENT}?`);
				const [code = '', ...rest] = present.trim().split(/\s+/);
				if (named(code) === undefined) {
					scope.warn(`The meter answered ${JSON.stringify(present.trim())} rather than a documented function name`);
				}
				return {
					function: named(code),
					code,
					// The section prints <func> alone as its response format and its own example answers the displayed
					// value after it, so whatever follows the name is kept rather than dropped.
					displayed: rest.length > 0 ? rest.join(' ') : undefined,
					raw: present,
					...measured(scope, await session.query(`${READ}?`)),
				};
			}),
	}),
	tool({
		name: 'configure_meter',
		description:
			'Enter or leave the handheld multimeter and set the function it measures, its range, its mA or V unit and its relative reading. Choosing a function resets every measurement parameter to its default, then the requested unit and relative setting are applied again. The selected function is verified, but the meter state, range, unit, and relative setting cannot be read back. SHS800X and SHS1000X handhelds only.',
		input: z
			.strictObject({
				meter: z.boolean().optional().describe('Enter the multimeter, or leave it and return to the oscilloscope'),
				function: z
					.enum(names)
					.optional()
					.describe('Measurement function. Selecting one returns every measurement parameter to its default'),
				range: z
					.enum(every('ranges'))
					.optional()
					.describe('Measurement range. AUTO ranges per measurement, MIN, MAX and DEF take the documented limits'),
				relative: z
					.boolean()
					.optional()
					.describe(
						'Whether readings are shown relative to a stored value. The instrument clears this on every function change',
					),
				unit: z.enum(['MA', 'A', 'MV', 'V']).optional().describe('Unit the current or voltage function displays in'),
			})
			.superRefine((input: Values, ctx) => {
				const entry = functions[String(input.function)];
				for (const field of ['range', 'relative', 'unit']) {
					if (input[field] !== undefined && entry === undefined) {
						ctx.addIssue({
							code: 'custom',
							message: `${field} belongs to a measurement function. Name the function it applies to`,
							path: [field],
						});
					}
				}
				if (input.relative !== undefined && entry !== undefined && entry.relative === undefined) {
					ctx.addIssue({
						code: 'custom',
						message: `Relative readings are not available for the ${input.function} measurement`,
						path: ['relative'],
					});
				}
				if (input.unit !== undefined && entry !== undefined && !(entry.units ?? []).includes(String(input.unit))) {
					ctx.addIssue({
						code: 'custom',
						message:
							entry.select === undefined
								? `Unit selection is not available for the ${input.function} measurement`
								: `The ${input.function} measurement takes ${(entry.units ?? []).join(' or ')}`,
						path: ['unit'],
					});
				}
				rangeOf('ranges')(input, ctx);
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const entry = functions[String(input.function)];
			const commands = plan(
				input.meter === true && `${METER} ON`,
				entry !== undefined && `${wire(entry.configure)}${input.range === undefined ? '' : ` ${input.range}`}`,
				input.unit !== undefined && entry?.select !== undefined && `${wire(entry.select)} ${input.unit}`,
				input.relative !== undefined &&
					entry?.relative !== undefined &&
					`${wire(entry.relative)} ${onOff(input.relative === true)}`,
				input.meter === false && `${METER} OFF`,
			);
			return scope.execute(async (session) => {
				requireMeter(scope);
				warnExtended(scope, input.range);
				for (const command of commands) await session.command(command);
				const write_only = commands.map((command) => command.split(' ')[0] ?? command);
				if (entry === undefined || input.meter === false) return { commands, write_only };
				const present = await session.query(`${PRESENT}?`);
				const code = present.trim().split(/\s+/)[0] ?? '';
				if (named(code) !== input.function) {
					scope.warn(`The function was set to ${input.function} but the meter reports ${JSON.stringify(code)}`);
				}
				return { commands, write_only, state: { function: named(code), code, raw: present } };
			});
		},
	}),
	tool({
		name: 'measure_meter',
		description:
			'Set the handheld multimeter to a function with its default parameters and read one measurement in the same call. This resets every measurement parameter of that function, so use configure_meter and read_meter when a parameter has to survive. A reading out of range answers Overload and is reported as such. SHS800X and SHS1000X handhelds only.',
		input: z
			.strictObject({
				function: z.enum(names).describe('Measurement function to switch to and read'),
				range: z
					.enum(every('measured'))
					.optional()
					.describe('Measurement range. Left out, the documented default of autoranging applies'),
			})
			.superRefine(rangeOf('measured')),
		// The query sets every measurement parameter of the function to its default before it answers, so it is not
		// the read-only call its question mark suggests.
		annotations: mutating,
		handler: ({ function: name, range }, scope) => {
			const entry = functions[name] as Measurement;
			const command = `${wire(entry.measure)}?${range === undefined ? '' : ` ${range}`}`;
			return scope.execute(async (session) => {
				requireMeter(scope);
				warnExtended(scope, range);
				return { commands: [command], function: name, ...measured(scope, await session.query(command)) };
			});
		},
	}),
];
