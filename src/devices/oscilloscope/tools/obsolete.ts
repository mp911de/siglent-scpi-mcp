// PG01-E02C's obsolete commands (pp. 283-305) stay off the modern tool surface: one registry, one reader, one sender.
import * as z from 'zod';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, parseFields, parseKeyValues } from '../../../scpi/values.ts';
import {
	clamped,
	compare,
	flag,
	inputs,
	list,
	type Param,
	pairs,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import type { Support } from '../models.ts';
import { type Channel, channels, type Scope, UnsupportedError } from '../scope.ts';
import { destructive, readOnly, tool } from './define.ts';
import { channel, hertz, pathSegment, volts } from './schema.ts';

const NOTE = 'Obsolete. Retained for older programs and not guaranteed on future products.';

// The guide gives each obsolete command its own availability table, whose rows are model series, not the families of
// models.ts: SDS1000CFL, SDS1000A and the CML+ group share one family there but answer differently here.
const series = [
	['SDS1000CFL', /^SDS1\d{3}CFL$/i],
	['SDS1000A', /^SDS1\d{3}A$/i],
	['SDS1000CML+/CNL+/DL+/E+/F+', /^SDS1\d{3}(CML|CNL|DL|E|F)\+$/i],
	['SDS2000X', /^SDS2\d{3}X?$/i],
	['SDS1000X', /^SDS1\d{3}X\+?$/i],
	['SDS1000X-E', /^SDS1\d{3}X-E$/i],
] as const;

type Series = (typeof series)[number][0];

const seriesOf = (model = ''): Series | undefined => series.find(([, pattern]) => pattern.test(model))?.[0];

// Two availability tables recur: the three oldest families alone, and every series but the SDS1000X-E.
const older = ['SDS1000CFL', 'SDS1000A', 'SDS1000CML+/CNL+/DL+/E+/F+'] as const;
const beforeXe = [...older, 'SDS2000X', 'SDS1000X'] as const;
const everySeries = series.map(([name]) => name);

type Line = 'pairs' | 'list';

// The one line the guide prints for a command instead of one command per parameter: pairs of mnemonic and value
// (C1:FILTS TYPE,BP,UPPLIMIT,200KHz) or the bare list of DATE 1,NOV,2017,14,38,16. The answer takes the same shape,
// and ask names the field the query carries as its argument (REF_SET? REF,RA).
interface Shape {
	line: Line;
	ask?: string;
}

// What the guide's per-series notes narrow: a field its format table prints for some series only (the CSVS data depth,
// p. 290), or the values of a field only some series reach (memory M11-M20 on the CFL series, p. 301).
interface Narrowed {
	models: readonly Series[];
	values?: readonly string[];
}

interface Obsolete {
	name: string;
	pages: string;
	what: string;
	models: readonly Series[];
	// the channel, FFT trace or memory the guide prefixes the command with: C1:FILT ON, TA:VPOS 3V, M1:REC DISK,UDSK.
	target?: Param;
	params: readonly Param[];
	composite?: Shape;
	narrowed?: Record<string, Narrowed>;
	// public field -> the values of the first parameter the guide lists it for; anything else is refused, and a field
	// listed here is optional rather than required.
	applies?: Record<string, readonly string[]>;
	equivalent: string;
	instead: string;
}

const state = (raw: string) => asState(raw, ['ON', 'OFF'] as const);

const autosetTypes = ['SP', 'MP', 'RS', 'DRP', 'RC'] as const;
const depths = ['MAX', 'DIS'] as const;
const filterTypes = ['LP', 'HP', 'BP', 'BR'] as const;
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const operations = ['START', 'STOP'] as const;
const outputs = ['FAIL', 'PASS'] as const;
const references = ['RA', 'RB', 'RC', 'RD'] as const;
const sources = [...channels, 'MATH'] as const;
const traces = ['TA', 'TB', 'TC', 'TD'] as const;
const zooms = [1, 2, 5, 10] as const;
const memories = Array.from({ length: 20 }, (_, index) => `M${index + 1}`);
const beyondTen = memories.slice(10);

const whole = (from: number, to: number) => z.number().int().min(from).max(to);

const davFile = z.object({
	file: pathSegment.describe('File name without the .DAV extension, up to eight characters'),
	directory: z
		.array(pathSegment)
		.max(4)
		.optional()
		.describe('Directory segments, for example ["WAVE"] for /WAVE/<file>.DAV. Omit for the root directory.'),
});

// The legal DOS path of the guide, quoted the way it prints it: FILE,'/WAVE/C1WF.DAV' (p. 301).
const davPath = (value: unknown): string => {
	const { file, directory } = value as z.output<typeof davFile>;
	return `'${directory?.length ? `/${directory.join('/')}/` : ''}${file}.DAV'`;
};

const registry = {
	ACAL: {
		name: 'AUTO_CALIBRATE',
		pages: '284',
		what: 'enable or disable the quick calibration the scope runs on its own',
		models: ['SDS1000CFL', 'SDS2000X'],
		params: [flag('quick_calibration', 'ACAL', 'quick calibration of the instrument', state)],
		equivalent: 'none (p. 283)',
		instead:
			'calibrate_scope runs the full user self-calibration. ACAL only switches quick calibration on or off and never starts it.',
	},
	AUTTS: {
		name: 'AUTO_TYPESET',
		pages: '285',
		what: 'select what auto-setup displays',
		models: beforeXe,
		params: [
			param(
				'autoset_type',
				'AUTTS',
				z.enum(autosetTypes),
				'SP one period, MP multiple periods, RS trigger on the rising side, DRP on the falling side, RC back to the state before auto-setup',
				(raw) => asState(raw, autosetTypes),
			),
		],
		equivalent: 'none (p. 283)',
		instead: 'autoset_scope runs Auto Setup. AUTTS only chooses what it displays.',
	},
	COUN: {
		name: 'COUNTER',
		pages: '286',
		what: 'show or hide the cymometer on screen',
		models: older,
		params: [flag('counter_display', 'COUN', 'cymometer display on the screen', state)],
		equivalent: 'none (p. 283)',
		instead: 'read_frequency_counter reads the counter over the wire (CYMT?) without touching the display',
	},
	CRAU: {
		name: 'CURSOR_AUTO',
		pages: '287',
		what: 'set the cursor mode to Auto',
		models: older,
		params: [],
		equivalent: 'none (p. 283)',
		instead: 'configure_cursors selects cursor modes. CRAU has no query form.',
	},
	// The guide prints a single RESPONSE FORMAT, CSV_SAVE <state>, beside three command formats (pp. 288-290). Every
	// series this server reaches uses Format 2 or 3, so the answer is read as the pairs those lines carry.
	CSVS: {
		name: 'CSV_SAVE',
		pages: '288-290',
		what: 'write the model, the serial number, the software version and the current settings into a CSV waveform file next to the waveform data, or leave the file with the data alone',
		models: everySeries,
		composite: { line: 'pairs' },
		narrowed: { data_depth: { models: older } },
		params: [
			param(
				'data_depth',
				'DD',
				z.enum(depths),
				'Max saves the maximum data depth. Display saves the depth shown on screen. Only the three oldest series support this field.',
				(raw) => asState(raw, depths),
			),
			flag('save_parameters', 'SAVE', 'the parameter block of the CSV file', state),
		],
		equivalent: 'none (p. 283)',
		instead:
			'PG01-E02C documents no current command for the parameter block of a CSV file, and prints a different line per series (p. 290): the state alone on the SDS1000X-E, SAVE,<state> on the SDS1000X and SDS2000X, DD,<depth>,SAVE,<state> on the three oldest. This server refuses every obsolete command on the SDS1000X-E, so it only ever sends the two longer forms',
	},
	DATE: {
		name: 'DATE',
		pages: '291-292',
		what: 'set the date and the time of the real-time clock inside the instrument',
		models: ['SDS1000CFL', 'SDS2000X'],
		composite: { line: 'list' },
		params: [
			param('day', '<day>', whole(1, 31), 'day of the month, 1 to 31', asQuantity),
			param('month', '<month>', z.enum(months), 'month, JAN to DEC', (raw) => asState(raw, months)),
			param('year', '<year>', whole(1990, 2089), 'year, 1990 to 2089', asQuantity),
			param('hour', '<hour>', whole(0, 23), 'hour, 0 to 23', asQuantity),
			param('minute', '<minute>', whole(0, 59), 'minute, 0 to 59', asQuantity),
			param('second', '<second>', whole(0, 59), 'second, 0 to 59', asQuantity),
		],
		equivalent: 'none (p. 283)',
		instead:
			'DATE is the only clock-setting command and is available on SDS1000CFL and SDS2000X. Changing the clock changes timestamps on files written by the scope.',
	},
	FFTZ: {
		name: 'FFT_ZOOM',
		pages: '293',
		what: 'select the zoom factor of the FFT trace',
		models: beforeXe,
		params: [param('fft_zoom', 'FFTZ', z.literal(zooms), 'zoom factor of the FFT trace', asQuantity)],
		equivalent: 'FFTT? (p. 293)',
		instead:
			'get_fft reports the FFT horizontal scale and configure_fft sets the remaining FFT settings. A zoom factor is related but is not the same setting.',
	},
	FILT: {
		name: 'FILTER',
		pages: '294',
		what: 'switch the filter of one analog channel on or off',
		models: older,
		target: param('channel', '<channel>', channel, 'Analog channel whose filter is configured.'),
		params: [flag('filter_enabled', 'FILT', 'filter of the channel, configured by FILTS', state)],
		equivalent: 'FILTS (p. 294), itself obsolete',
		instead:
			'No current typed tool configures this filter. configure_channel provides only the separate 20 MHz bandwidth limit.',
	},
	FILTS: {
		name: 'FILT_SET',
		pages: '295-296',
		what: 'select the filter type of one analog channel and set its limit frequencies',
		models: older,
		target: param('channel', '<channel>', channel, 'Analog channel whose filter is configured.'),
		composite: { line: 'pairs' },
		applies: { upper_limit: ['LP', 'BP', 'BR'], lower_limit: ['HP', 'BP', 'BR'] },
		params: [
			param(
				'filter_type',
				'TYPE',
				z.enum(filterTypes),
				'LP low-pass, HP high-pass, BP band-pass, BR band-reject',
				(raw) => asState(raw, filterTypes),
			),
			clamped(
				'upper_limit',
				'UPPLIMIT',
				hertz,
				'Upper limit frequency. Available only for Low Pass, Band Pass, and Band Reject.',
				asQuantity,
				1,
			),
			clamped(
				'lower_limit',
				'LOWLIMIT',
				hertz,
				'Lower limit frequency. Available only for High Pass, Band Pass, and Band Reject.',
				asQuantity,
				1,
			),
		],
		equivalent: 'FILT (p. 295), itself obsolete',
		instead:
			'No current typed tool configures this filter. configure_channel provides only the separate 20 MHz bandwidth limit.',
	},
	PDET: {
		name: 'PEAK_DETECT',
		pages: '297',
		what: 'switch the peak-detect acquisition on or off',
		models: beforeXe,
		params: [flag('peak_detect', 'PDET', 'peak-detect acquisition', state)],
		equivalent: 'ACQW (p. 297)',
		instead: 'configure_acquisition selects Peak Detect and also names the mode to return to.',
	},
	PFCT: {
		name: 'PF_CONTROL',
		pages: '298-299',
		what: 'set the source of the pass/fail test, run or stop it, fire its output on a failed or on a passed frame, and stop the test when that output fires',
		models: beforeXe,
		composite: { line: 'pairs' },
		params: [
			param('source', 'TRACE', channel, 'analog channel the test runs on', (raw) => asState(raw, channels)),
			param('operate', 'CONTROL', z.enum(operations), 'START runs the test, STOP ends it', (raw) =>
				asState(raw, operations),
			),
			param('output', 'OUTPUT', z.enum(outputs), 'fire the output on a failed or on a passed frame', (raw) =>
				asState(raw, outputs),
			),
			flag('stop_on_output', 'OUTPUTSTOP', 'stopping the test as soon as the output fires', state),
		],
		equivalent: 'PFSC, PFBF, PFOP, PFFS (p. 283), one command split into four',
		instead:
			'configure_pass_fail_mask sets the source. configure_pass_fail runs the test and controls stop-on-fail. This obsolete command uses a different output-based stop condition.',
	},
	PERS: {
		name: 'PERSIST',
		pages: '300',
		what: 'switch the persistence display mode on or off',
		models: beforeXe,
		params: [flag('persistence', 'PERS', 'persistence display mode', state)],
		equivalent: 'PESU (p. 300)',
		instead: 'configure_display sets persistence duration. PERS only switches persistence on or off.',
	},
	REC: {
		name: 'RECALL',
		pages: '301',
		what: 'recall a waveform file from a USB memory device into one of the internal waveform memories',
		models: beforeXe,
		target: param(
			'memory',
			'<memory>',
			z.enum(memories),
			'Internal waveform memory to replace. M1-M10 are generally available. CFL models also support M11-M20.',
		),
		composite: { line: 'pairs' },
		narrowed: { memory: { models: ['SDS1000CFL'], values: beyondTen } },
		params: [
			param(
				'device',
				'DISK',
				z.literal('UDSK'),
				'Mass-storage device containing the file. Only a connected USB memory device is supported.',
			),
			{
				...param('file', 'FILE', davFile, 'Waveform file on the USB memory device.'),
				wire: davPath,
			},
		],
		equivalent: 'none (p. 283)',
		instead:
			'recall_panel_setup recalls a front-panel setup. REC loads a waveform file into waveform memory and replaces its contents without a query form.',
	},
	REFS: {
		name: 'REF_SET',
		pages: '302-303',
		what: 'point one reference waveform at a trace, show or hide it, and save that trace into it on the spot',
		models: beforeXe,
		composite: { line: 'pairs', ask: 'reference' },
		applies: { save_to_reference: sources },
		params: [
			param('reference_source', 'TRACE', z.enum(sources), 'trace the reference waveform is taken from'),
			param('reference', 'REF', z.enum(references), 'Reference waveform RA-RD to configure.', (raw) =>
				asState(raw, references),
			),
			flag('display', 'STATE', 'the named reference waveform on screen', state),
			{
				...param(
					'save_to_reference',
					'SAVE',
					z.literal(true),
					'Save the trace into the selected reference waveform, replacing its current contents.',
				),
				wire: () => 'DO',
			},
		],
		equivalent: 'REFSR, REFLA, REFDS, REFSA (p. 283), one command split into four',
		instead:
			'configure_reference names the source (REFSR) and the location (REFLA), shows it (REFDS) and saves into it (REFSA), one command each, and calls the locations REFA-REFD where this one calls them RA-RD. PG01-E02C lists those four for the SDS1000X-E alone and REFS for every other series, so no scope takes both',
	},
	VPOS: {
		name: 'VERT_POSITION',
		pages: '304-305',
		what: 'move one FFT trace up or down the screen without touching the offset of the acquisition',
		models: beforeXe,
		target: param('trace', '<trace>', z.enum(traces), 'FFT trace to move.'),
		params: [
			clamped(
				'vertical_position',
				'VPOS',
				volts,
				'vertical position, -20 to 20 divisions of the current scale',
				asQuantity,
				1e-6,
			),
		],
		equivalent: 'FFTP (p. 304)',
		instead:
			'configure_fft sets the current FFT vertical offset. VPOS addresses traces TA-TD and uses a different range.',
	},
} satisfies Record<string, Obsolete>;

type Id = keyof typeof registry;

const ids = Object.keys(registry) as [Id, ...Id[]];

const entry = (id: Id): Obsolete => registry[id];

const fields = (id: Id): readonly Param[] => {
	const { target, params } = entry(id);
	return target ? [target, ...params] : params;
};

// The channel of FILT and FILTS is one field under one name, so the flat input keeps one row per public name.
const all = [...new Map(ids.flatMap(fields).map((row) => [row.name, row])).values()];

// A composite answers in the shape its response format prints: one line of pairs, C1:FILTER TYPE,BP,UPPLIMIT,2.0E+5,
// or a bare list, DATE 1,NOV,2017,14,38,16, whose fields fall on the parameters the guide answers, in order.
function collect(params: readonly Param[], raw: string, answer: Line): Values {
	const answered = answer === 'pairs' ? parseKeyValues(raw) : undefined;
	const positional = answered ? [] : parseFields(raw);
	const state: Values = {};
	params
		.filter(({ parse }) => parse)
		.forEach(({ name, mnemonic, parse }, index) => {
			const value = answered ? answered[mnemonic] : positional[index];
			if (parse && value !== undefined) state[name] = parse(value);
		});
	return state;
}

// REF_SET? REF,RA answers for the one reference it names (p. 302); every other query here carries no argument.
function argument(id: Id, input?: Values): string {
	const { params, composite } = entry(id);
	const asked = params.find(({ name }) => name === composite?.ask);
	return asked && input ? ` ${pairs([asked], input)}` : '';
}

// PG01-E02C gives CRAU and REC no query form at all; every other command answers, some only for a named target.
const writeOnly = (id: Id): boolean => !entry(id).params.some(({ parse }) => parse);

const readable = (id: Id, input?: Values): boolean => {
	const { target, composite } = entry(id);
	return !writeOnly(id) && (input !== undefined || !(target || composite?.ask));
};

const read = async (session: ScpiSession, id: Id, prefix = '', input?: Values): Promise<Values> => {
	const { params, composite } = entry(id);
	if (!composite) return readback(session, params, prefix);
	const raw = await session.query(`${prefix}${id}?${argument(id, input)}`);
	return collect(params, raw, composite.line);
};

function availability(id: Id, scope: Scope): Support {
	const found = seriesOf(scope.identity?.model);
	return found === undefined ? 'unknown' : entry(id).models.includes(found) ? 'supported' : 'unsupported';
}

function requireModel(id: Id, scope: Scope): Support {
	const { model = 'This model' } = scope.identity ?? {};
	const support = availability(id, scope);
	if (support === 'unsupported') {
		throw new UnsupportedError(`${model} (${seriesOf(model)}) does not support the obsolete ${id} command.`);
	}
	if (support === 'unknown') scope.warn(`${id} support on ${model} is unknown. Sending it anyway.`);
	return support;
}

// The per-series notes beside the availability table: the format of CSVS and the memories of REC differ by series.
function requireSeries(id: Id, scope: Scope, input: Values): void {
	const found = seriesOf(scope.identity?.model);
	if (found === undefined) return;
	const { narrowed = {} } = entry(id);
	const refuse = (why: string) => {
		throw new UnsupportedError(`${why}. Choose a command supported by this model.`);
	};
	for (const [name, { models, values }] of Object.entries(narrowed)) {
		const given = input[name];
		const takes = models.includes(found);
		if (values) {
			if (!takes && values.includes(String(given))) refuse(`${name} ${String(given)} belongs to ${models.join(', ')}`);
		} else if (takes && given === undefined) refuse(`the ${id} line of ${found} names ${name}`);
		else if (!takes && given !== undefined) refuse(`the ${id} line of ${found} has no ${name}`);
	}
}

const describe = (id: Id, support: Support) => {
	const { name, pages, what, equivalent, instead, models, target, composite } = entry(id);
	return {
		command: id,
		name,
		pages,
		what,
		support,
		models: models.join(', '),
		...((target || composite?.ask) && { target: target?.name ?? composite?.ask }),
		equivalent,
		instead,
		obsolete: NOTE,
	};
};

// The one cross-field rule of the registry, and the guide's own: DATE performs validity checking (p. 291), so a day
// its month does not have never reaches the clock.
function calendar({ day, month, year }: Values): string | undefined {
	const at = new Date(Number(year), months.indexOf(month as (typeof months)[number]), Number(day));
	return at.getDate() === Number(day) ? undefined : `${String(day)} ${String(month)} ${String(year)} is not a date`;
}

// A field the guide prints in brackets or gives to some series only: requireSeries refuses it where it does not belong.
function conditional(id: Id, name: string): boolean {
	const { applies = {}, narrowed = {} } = entry(id);
	const narrow = narrowed[name];
	return name in applies || (narrow !== undefined && narrow.values === undefined);
}

function mismatch(input: Values): string | undefined {
	const id = input.command as Id;
	const { params, applies = {} } = entry(id);
	// The gate of a conditional field is the first parameter, which the wire sends first: FILTS TYPE decides its limits.
	const gate = String(input[params[0]?.name ?? ''] ?? '');
	const belongs = new Set(fields(id).map(({ name }) => name));
	const missing = fields(id)
		.filter(({ name }) => input[name] === undefined && !conditional(id, name))
		.map(({ name }) => name);
	const misplaced = Object.keys(applies).filter((name) => input[name] !== undefined && !applies[name]?.includes(gate));
	const extra = all.filter(({ name }) => input[name] !== undefined && !belongs.has(name)).map(({ name }) => name);
	if (missing.length > 0) return `${id} needs ${missing.join(', ')}`;
	if (misplaced.length > 0)
		return misplaced.map((name) => `${name} applies to ${applies[name]?.join(', ')}, not to ${gate}`).join('. ');
	if (extra.length > 0) return `${extra.join(', ')} belongs to another obsolete command, not to ${id}`;
	return id === 'DATE' ? calendar(input) : undefined;
}

export const obsoleteTools = [
	tool({
		name: 'get_obsolete_settings',
		description:
			'Read the inventory and available values of obsolete commands supported by this scope. Each entry explains its former purpose, supported model series, and current replacement. Unsupported commands are listed without a value. Commands without a query form are marked write-only. Obsolete commands may be removed from future products.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('obsolete');
				const listed = [];
				for (const id of ids) {
					const support = availability(id, scope);
					const queried = support === 'supported' && readable(id);
					listed.push({
						...describe(id, support),
						...(writeOnly(id) && { write_only: [id] }),
						...(queried && { values: await read(session, id) }),
					});
				}
				return {
					model: scope.identity?.model,
					family: scope.capabilities?.family,
					series: seriesOf(scope.identity?.model) ?? 'not listed in the obsolete availability tables',
					inventory: listed,
				};
			}),
	}),
	tool({
		name: 'send_obsolete_command',
		description:
			'Send one obsolete command using only the fields supported by that command and model series. Overwriting a reference or memory cannot be detected or read back. Commands without a query form are marked write-only. Requires `confirm_obsolete: true`. Nothing is sent otherwise. The result names the current replacement tool. Obsolete commands may be removed from future products.',
		input: z
			.strictObject({
				command: z.enum(ids).describe('Obsolete command to send. get_obsolete_settings lists them.'),
				confirm_obsolete: z
					.literal(true)
					.describe('Explicit acknowledgement that an obsolete command is sent instead of its current equivalent'),
				...inputs(all),
			})
			.superRefine((input, ctx) => {
				const problem = mismatch(input as Values);
				if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['command'] });
			}),
		annotations: destructive,
		handler: (input, scope) =>
			scope.execute(async (session) => {
				const id = input.command;
				const given = input as Values;
				scope.require('obsolete');
				const support = requireModel(id, scope);
				requireSeries(id, scope, given);
				const { target, params, composite } = entry(id);
				for (const { name } of fields(id)) {
					const value = String(given[name]);
					if ((channels as readonly string[]).includes(value)) scope.requireChannel(value as Channel);
				}
				const prefix = target ? `${String(given[target.name])}:` : '';
				const sent = composite
					? [`${prefix}${id} ${(composite.line === 'list' ? list : pairs)(params, given)}`]
					: params.length > 0
						? settings(params, given, prefix)
						: [id];
				for (const command of sent) await session.command(command);
				const values = readable(id, given) ? await read(session, id, prefix, given) : undefined;
				if (values) compare(scope, params, given, values, `${id}? reports what the scope took`);
				return {
					...describe(id, support),
					commands: sent,
					...(writeOnly(id) && { write_only: [id] }),
					...(values && { values }),
				};
			}),
	}),
];
