import * as z from 'zod';
import type { FrameReader } from '../../../scpi/codec.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseKeyValues, parseQuantity, type Quantity } from '../../../scpi/values.ts';
import { compare, inputs, pairs, param, type Values } from '../../../tools/params.ts';
import { type Channel, channels, type Scope, UnsupportedError } from '../scope.ts';
import { mutating, tool } from './define.ts';
import { type MathDefinition, readDefinition } from './math.ts';
import { digitals, timeoutMs } from './schema.ts';

const GRID = 14;
const DEFAULT_POINTS = 1000;
const MAX_POINTS = 14_000_000;
const MAX_INLINE_POINTS = 4_096;
const MAX_CSV_POINTS = 200_000;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
const TRANSFER_TIMEOUT = 30_000;

const LF = 0x0a;
const CR = 0x0d;
const HASH = 0x23;
const MAX_PREFIX = 64;

const sources = [...channels, 'MATH', ...digitals] as const;
type Source = (typeof sources)[number];
type Kind = 'analog' | 'math' | 'digital';

const kindOf = (source: Source): Kind => (source === 'MATH' ? 'math' : source.startsWith('D') ? 'digital' : 'analog');

const round = (value: number): number => Number(value.toPrecision(12));

const number = (quantity: Quantity | { raw: string }): number | undefined =>
	'value' in quantity ? quantity.value : undefined;

const head = (buffer: Buffer): string => JSON.stringify(buffer.toString('latin1', 0, Math.min(buffer.length, 32)));

interface Block {
	declared?: number;
}

// The reply is "<trace>:WF ALL,#9<nine digits><data>0A 0A". For analog and math the nine digits count bytes
// (pp. 264, 270); for digital they count points, one bit each, so the block is ceil(points / 8) bytes (p. 268).
function waveformFrame(packed: boolean, block: Block): FrameReader {
	return (buffer) => {
		const hash = buffer.indexOf(HASH);
		if (hash < 0 && buffer.length <= MAX_PREFIX) return undefined;
		if (hash < 0 || hash > MAX_PREFIX) throw new ScpiError(`The scope returned invalid waveform data: ${head(buffer)}`);
		if (buffer.length < hash + 2) return undefined;
		const digits = (buffer[hash + 1] ?? 0) - 0x30;
		if (digits < 1 || digits > 9) throw new ScpiError(`The scope returned invalid waveform data: ${head(buffer)}`);
		const start = hash + 2 + digits;
		if (buffer.length < start) return undefined;
		const declared = Number.parseInt(buffer.toString('ascii', hash + 2, start), 10);
		if (Number.isNaN(declared))
			throw new ScpiError(`The scope returned waveform data with an unreadable length: ${head(buffer)}`);
		const bytes = packed ? Math.ceil(declared / 8) : declared;
		if (bytes > MAX_TRANSFER_BYTES) {
			throw new ScpiError(
				`The waveform contains ${declared} ${packed ? 'points' : 'bytes'} (${bytes} bytes), exceeding the ${MAX_TRANSFER_BYTES} byte transfer limit. Reduce the transfer with points or sparsing.`,
			);
		}
		if (buffer.length < start + bytes) return undefined;
		block.declared = declared;
		let end = start + bytes;
		while (end < buffer.length && (buffer[end] === LF || buffer[end] === CR)) end++;
		return { payload: buffer.subarray(start, start + bytes), end };
	};
}

const count = z.int().min(0).max(MAX_POINTS);

const params = [
	param('sparsing', 'SP', count, 'Interval between transferred points. Values 0 and 1 transfer every point.'),
	param('points', 'NP', count, 'Number of points to transfer. Zero transfers the whole record.'),
	param('first_point', 'FP', count, 'index of the first point to transfer, 0 is the first acquired point'),
];

function parseTransfer(raw: string): Values {
	const fields = parseKeyValues(raw);
	const state: Values = { raw };
	for (const { name, mnemonic } of params) {
		const value = parseQuantity(fields[mnemonic] ?? '')?.value;
		if (value !== undefined) state[name] = value;
	}
	return state;
}

// PG01-E02C converts a sample with voltage = code * (vdiv / 25), a code above 127 read as code - 255 (pp. 265, 270).
// Both constants belong to its 8-bit families; a scope of any other or unknown resolution gets its codes back
// untouched, because a plausible-looking voltage from the wrong scaling is worse than no voltage at all.
function converter(scope: Scope, vdiv: number | undefined, offset: number | undefined, what: string) {
	const { bits, codesPerDivision } = scope.capabilities?.resolution ?? {};
	if (vdiv === undefined || offset === undefined) {
		scope.warn(`${what} could not be read as a number. Raw codes are returned without voltage conversion.`);
		return undefined;
	}
	if (bits !== 8 || !codesPerDivision) {
		scope.warn(
			`${scope.identity?.model ?? 'The scope'} reports ${bits ? `${bits}-bit samples` : 'an unknown sample resolution'}. Voltage conversion requires 8-bit samples and a known vertical scale, so raw codes are returned.`,
		);
		return undefined;
	}
	const scale = vdiv / codesPerDivision;
	return (code: number) => round((code > 127 ? code - 255 : code) * scale - offset);
}

// A digital point is one bit, LSB first (p. 268); an analog or math point is one byte.
type Sample = (index: number) => number;

const codeAt = (payload: Buffer, packed: boolean): Sample =>
	packed ? (index) => ((payload[index >> 3] ?? 0) >> (index & 7)) & 1 : (index) => payload[index] ?? 0;

const take = (count: number, at: Sample): number[] => Array.from({ length: count }, (_, index) => at(index));

// One pass over the record without holding it: a 16 MiB block is 16 million points, and an array of them costs more
// than a hundred megabytes, so the statistics read the payload where the returned series is cut to what is shown.
function summarize(count: number, at: Sample) {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let total = 0;
	for (let index = 0; index < count; index++) {
		const value = at(index);
		if (value < min) min = value;
		if (value > max) max = value;
		total += value;
	}
	return { count, ...(count > 0 && { min: round(min), max: round(max), mean: round(total / count) }) };
}

const csv = (header: string, times: number[] | undefined, series: number[]): string =>
	[`${times ? 'time' : 'index'},${header}`, ...series.map((v, i) => `${times ? times[i] : i},${v}`)].join('\n');

interface WaveformInput extends Values {
	source?: Source;
	channel?: Source;
	output: 'points' | 'summary' | 'csv';
	horizontal_divisions: number;
	timeout_ms?: number;
}

// MATH and the digital lines are SDS1000X-E only, and MATH:WF? excludes FFT (p. 263).
async function requireSource(
	session: ScpiSession,
	scope: Scope,
	source: Source,
	kind: Kind,
): Promise<MathDefinition | undefined> {
	if (kind === 'digital') {
		scope.require('mso_xe');
		return undefined;
	}
	if (kind === 'analog') {
		scope.requireLegacyDialect();
		scope.requireChannel(source as Channel);
		return undefined;
	}
	scope.require('xe');
	const definition = await readDefinition(session);
	if (definition.operation === 'fft') {
		throw new UnsupportedError(
			'FFT waveforms cannot be transferred through get_waveform. Choose another math operation.',
		);
	}
	if (!definition.operation) {
		scope.warn(
			`The math operation response ${JSON.stringify(definition.equation_raw)} was not recognized. FFT exclusion was not verified.`,
		);
	}
	return definition;
}

export const waveformTools = [
	tool({
		name: 'get_waveform',
		description:
			'Transfer a waveform from channels C1-C4, Math, or digital lines D0-D15. Math and digital sources require SDS1000X-E, and digital sources require the MSO option. FFT waveforms are not supported. Analog and Math samples are returned as time and voltage when the sample resolution is known, otherwise as raw codes. Digital samples are returned as time and logic state. Transfers default to 1000 points and a 30-second timeout. Up to 4096 points are returned inline or 200000 as a CSV resource. Transfers larger than 16 MiB are refused. This tool changes the persistent waveform-transfer settings.',
		input: z.strictObject({
			source: z.enum(sources).optional().describe('C1-C4, Math, or D0-D15. channel is accepted as an alias.'),
			channel: z.enum(sources).optional().describe('Alias of source'),
			...inputs(params),
			output: z
				.enum(['points', 'summary', 'csv'])
				.default('points')
				.describe(
					'Points returns samples inline. Summary returns only statistics. CSV attaches samples as a resource.',
				),
			horizontal_divisions: z
				.int()
				.min(1)
				.max(20)
				.default(GRID)
				.describe('Horizontal grid divisions used to calculate the first point time. Defaults to 14.'),
			timeout_ms: timeoutMs.describe('Transfer timeout in milliseconds, default 30000'),
		}),
		annotations: mutating,
		handler: (input: WaveformInput, scope) => {
			const { output, horizontal_divisions: grid, timeout_ms } = input;
			const source = input.source ?? input.channel;
			if (!source)
				throw new ScpiError('A waveform source is required. Set source or channel to C1-C4, Math, or D0-D15.');
			const kind = kindOf(source);
			const requested = {
				sparsing: (input.sparsing as number) ?? 0,
				points: (input.points as number) ?? (kind === 'math' ? 0 : DEFAULT_POINTS),
				first_point: (input.first_point as number) ?? 0,
			};
			const bounded = requested.points > 0 || requested.sparsing > 1 || requested.first_point > 0;
			const setup = `WFSU ${pairs(params, requested)}`;
			const query = `${source}:WF? DAT2`;
			return scope.execute(async (session) => {
				const definition = await requireSource(session, scope, source, kind);
				const vdiv =
					kind === 'digital'
						? undefined
						: asQuantity(await session.query(kind === 'math' ? 'MTVD?' : `${source}:VDIV?`));
				const offset = kind === 'analog' ? asQuantity(await session.query(`${source}:OFST?`)) : undefined;
				const timebase = asQuantity(await session.query('TDIV?'));
				const rate = asQuantity(await session.query(kind === 'digital' ? 'DI:SARA?' : 'SARA?'));
				const acquired = definition?.sources?.[0]
					? asQuantity(await session.query(`SANU? ${definition.sources[0]}`))
					: undefined;
				await session.command(setup);
				const applied = parseTransfer(await session.query('WFSU?'));
				compare(scope, params, requested, applied, 'The waveform transfer settings');

				const block: Block = {};
				const reader = waveformFrame(kind === 'digital', block);
				const payload = await session.queryBinary(query, timeout_ms ?? TRANSFER_TIMEOUT, reader);
				const bits = payload.length * 8;
				const points = kind === 'digital' ? Math.min(block.declared ?? bits, bits) : payload.length;
				const code = codeAt(payload, kind === 'digital');

				const convert =
					vdiv &&
					converter(
						scope,
						number(vdiv),
						offset ? number(offset) : 0,
						kind === 'math' ? 'The Math vertical scale' : 'The channel vertical scale or offset',
					);
				const sample: Sample = convert ? (index) => convert(code(index)) : code;
				const header = kind === 'digital' ? 'state' : convert ? 'voltage' : 'code';

				// A math point is one interpolated step, sample interval over block length divided by SANU? (p. 271);
				// a transfer bounded by SP, NP or FP no longer carries that ratio, so it comes back without times.
				const acquiredPoints = acquired && number(acquired);
				const multiplier = !bounded && acquiredPoints ? points / acquiredPoints : undefined;
				if (kind === 'math' && multiplier === undefined) {
					scope.warn(
						'A bounded Math transfer cannot determine point times. Leave points, sparsing, and first_point unset to transfer the whole record with timing.',
					);
				}
				const rateValue = number(rate);
				const interval =
					!rateValue || (kind === 'math' && !multiplier) ? undefined : 1 / (rateValue * (multiplier ?? 1));
				if (interval && (requested.sparsing > 1 || requested.first_point > 0)) {
					scope.warn(
						'Timing with sparsing or first_point is calculated from the sample interval and is unverified on hardware.',
					);
				}
				const origin = number(timebase);
				const timeAt =
					origin === undefined || interval === undefined
						? undefined
						: (index: number) =>
								round(
									-(origin * grid) / 2 + (requested.first_point + index * Math.max(requested.sparsing, 1)) * interval,
								);

				// The caps bound what is allocated, not only what is returned: the sample and time arrays are built for
				// the points that leave this tool, whatever the scope sent.
				const limit = output === 'csv' ? MAX_CSV_POINTS : MAX_INLINE_POINTS;
				const shown = output === 'summary' ? 0 : Math.min(points, limit);
				const series = take(shown, sample);
				const times = timeAt && take(shown, timeAt);
				const truncated = output !== 'summary' && shown < points;
				if (truncated) {
					scope.warn(
						`The transfer returned ${points} points, but only the first ${shown} are included. Use points, sparsing, or first_point to reduce the transfer.`,
					);
				}
				return {
					source,
					kind,
					commands: [setup, query],
					transfer: { requested, applied },
					block: { declared: block.declared, bytes: payload.length, points },
					timing: {
						timebase,
						sample_rate: rate,
						horizontal_divisions: grid,
						...(acquired && { acquired_points: acquired }),
						...(multiplier !== undefined && { interpolation_multiplier: round(multiplier) }),
						...(interval !== undefined && { interval: round(interval) }),
						...(timeAt && points > 0 && { first_time: timeAt(0), last_time: timeAt(points - 1) }),
					},
					...(vdiv && {
						scaling: {
							volts_per_division: vdiv,
							...(offset && { offset }),
							resolution: scope.capabilities?.resolution,
							converted: convert !== undefined,
						},
					}),
					summary: summarize(points, sample),
					...(output === 'points' && {
						waveform: { ...(times && { time: times }), [header]: series, truncated },
					}),
					...(output === 'csv' && {
						csv: { points: shown, truncated },
						content: [
							{
								type: 'resource' as const,
								resource: {
									uri: `siglent://waveform/${source}`,
									mimeType: 'text/csv',
									text: csv(header, times, series),
								},
							},
						],
					}),
				};
			});
		},
	}),
];
