import * as z from 'zod';
import { announcedLength, type FrameReader, readBinary } from '../../../scpi/codec.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { isOn, parseQuantity } from '../../../scpi/values.ts';
import { timeoutMs } from '../../../tools/schema.ts';
import { horizontalGrid } from '../models.ts';
import { type Channel, channels, counted } from '../scope.ts';
import { destructive, tool } from './define.ts';
import { type Preamble, parsePreamble } from './preamble.ts';

const MAX_POINTS = 200_000_000;
const MAX_PIECE_BYTES = 16 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_PIECES = 64;
const MAX_PREAMBLE_BYTES = 4096;
const MAX_INLINE_POINTS = 4096;
const MAX_CSV_POINTS = 200_000;
const DEFAULT_POINTS = 1000;
const TRANSFER_TIMEOUT = 30_000;
// The ADC cannot reach beyond its own range, so a reading further from the ground than the whole screen means the
// codes and code_per_div are not counted in the same unit; the sample width is the only thing that can differ.
const IMPLAUSIBLE_DIVISIONS = 10;

const LF = 0x0a;
const CR = 0x0d;

const round = (value: number): number => Number(value.toPrecision(12));

// The guide's own example ends a waveform block with "0A 0A" (p. 694), which belongs to the answer rather than to
// the next one; the ceiling is checked against the length the block announces, before any of it is buffered.
const bounded =
	(what: string, limit: number): FrameReader =>
	(buffer) => {
		const declared = announcedLength(buffer);
		if (declared !== undefined && declared > limit) {
			throw new ScpiError(
				`${what} announced ${declared} bytes, exceeding the ${limit} byte limit. Reduce points or raise interval`,
			);
		}
		const frame = readBinary(buffer);
		if (!frame) return undefined;
		let { end } = frame;
		while (buffer[end] === LF || buffer[end] === CR) end++;
		return { payload: frame.payload, end };
	};

const descriptor = bounded('The waveform descriptor', MAX_PREAMBLE_BYTES);
const samples = bounded('The waveform data', MAX_PIECE_BYTES);

// A sample is a signed code: one byte, or one word left-aligned in the order COMM_ORDER announces (pp. 689, 694).
const codeAt = ({ width, byte_order }: Preamble, payload: Buffer): ((index: number) => number) => {
	if (width === 'BYTE') return (index) => payload.readInt8(index);
	return byte_order === 'MSB' ? (index) => payload.readInt16BE(index * 2) : (index) => payload.readInt16LE(index * 2);
};

const csv = (header: string, times: number[] | undefined, series: number[]): string =>
	[`${times ? 'time' : 'index'},${header}`, ...series.map((value, i) => `${times ? times[i] : i},${value}`)].join('\n');

const readPreamble = async (session: ScpiSession, timeout: number) =>
	parsePreamble(await session.queryBinary(':WAVeform:PREamble?', timeout, descriptor));

// F1 to F4 mirrors the sanity cap on "# math functions", which the guide never puts a number to (p. 683).
const traces = [...channels, 'F1', 'F2', 'F3', 'F4'] as [string, ...string[]];
const trace = z.enum(traces);
const target = {
	source: trace.optional().describe('Analog channel C1-C4 or math function F1-F4. channel is accepted as an alias'),
	channel: trace.optional().describe('Alias of source'),
};

function sourceOf({ source: named, channel }: { source?: string; channel?: string }): string {
	const chosen = named ?? channel;
	if (!chosen) throw new ScpiError('A source is required: pass source (or channel) as C1-C4 or F1-F4');
	return chosen;
}

export const waveformTools = [
	tool({
		name: 'get_waveform',
		description:
			'Transfer an analog waveform and return time and voltage values with summary statistics. Annotated destructive because on an SDS1204X HD with firmware 6.9.13.1.1.6.7 full record decimated transfers were followed three times by an acquisition state that only a power cycle cleared, so --disable-destructive-commands hides this tool until that behaviour is understood. The transfer is limited to 64 MiB and 64 pieces. Point output is reduced to at most 4096 values and CSV output to 200000 values. points defaults to 1000. Set points to 0 for the full record and use interval to reduce data at the scope. Samples are decoded with the width the descriptor reports, and a scope that keeps another width than the requested one raises a warning. The scaling result names the transferred sample width and the known ADC resolution separately, because the descriptor reports the container width rather than the converter. This changes the retained waveform transfer settings. Waveform traffic engages the front-panel remote lock on some firmware, so the lock is released after the transfer unless the server runs with the enable-lock flag. A math source F1-F4 is transferred after its function answers ON and refused with a warning while it is off, and its values come back in the unit of the trace. Digital sources are not supported.',
		input: z
			.strictObject({
				...target,
				first_point: z
					.int()
					.min(0)
					.max(MAX_POINTS)
					.default(0)
					.describe('Index of the first point to transfer. Zero is the first acquired point'),
				points: z
					.int()
					.min(0)
					.max(MAX_POINTS)
					.default(DEFAULT_POINTS)
					.describe('Number of points to transfer. Zero transfers the whole record'),
				interval: z
					.int()
					.min(1)
					.max(1_000_000)
					.default(1)
					.describe('Spacing between transferred points. One transfers every point'),
				frame: z
					.int()
					.min(0)
					.max(100_000)
					.optional()
					.describe(
						'Sequence frame index, valid while sequence mode is on. Zero transfers as many frames as fit in one response',
					),
				frame_start: z
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe('First sequence frame of the slice. Requires frame to be zero'),
				output: z
					.enum(['points', 'summary', 'csv'])
					.default('points')
					.describe(
						'points returns the series inline, summary only the statistics, csv attaches it as a text/csv resource',
					),
				horizontal_divisions: z
					.int()
					.min(1)
					.max(20)
					.optional()
					.describe(
						'Grid divisions across the screen, used to calculate the time of the first point. Defaults to 10 for SDS models and 12 for SHS models',
					),
				timeout_ms: timeoutMs.describe('Timeout of one transfer in milliseconds, default 30000'),
			})
			.refine(({ frame, frame_start }) => frame_start === undefined || frame === 0, {
				message: 'frame_start requires frame to be zero. Set frame to zero or remove frame_start',
				path: ['frame_start'],
			}),
		annotations: destructive,
		handler: (input, scope) => {
			const source = sourceOf(input);
			const { first_point, points, interval, output, timeout_ms } = input;
			const timeout = timeout_ms ?? TRANSFER_TIMEOUT;
			const math = /^F(\d)$/.exec(source);
			return scope.execute(async (session) => {
				if (math) {
					if (!isOn(await session.query(`:FUNCtion${math[1]}?`))) {
						scope.warn(`${source} is switched off, and a transfer from an undefined math function may never answer`);
						throw new Error(
							`${source} is switched off. Enable it with configure_math {function: ${math[1]}, enabled: true} before transferring it`,
						);
					}
				} else scope.requireChannel(source as Channel);
				const grid = input.horizontal_divisions ?? horizontalGrid(scope.identity?.model ?? '');
				const commands: string[] = [];
				const send = async (command: string) => {
					commands.push(command);
					await session.command(command);
				};

				await send(`:WAVeform:SOURce ${source}`);
				if (input.frame !== undefined) await send(`:WAVeform:SEQuence ${input.frame},${input.frame_start ?? 1}`);
				await send(`:WAVeform:INTerval ${interval}`);
				await send(`:WAVeform:STARt ${first_point}`);

				let preamble = await readPreamble(session, timeout);
				const wanted = preamble.adc_bits > 8 ? 'WORD' : 'BYTE';
				if (preamble.width !== wanted) {
					await send(`:WAVeform:WIDTh ${wanted}`);
					preamble = await readPreamble(session, timeout);
					if (preamble.width !== wanted) {
						scope.warn(
							`Sample width was set to ${wanted}, but the waveform descriptor reports ${preamble.width}. Samples are decoded as ${preamble.width}.`,
						);
					}
				}
				const width = preamble.width;
				const sequence = input.frame === undefined ? undefined : await session.query(':WAVeform:SEQuence?');

				// The descriptor echoes what the scope took for :WAVeform:STARt and :WAVeform:INTerval, so the time of a
				// point is built from what it took rather than from what was asked for.
				for (const [name, wanted, taken] of [
					['first_point', first_point, preamble.first_point],
					['interval', interval, preamble.data_interval],
				] as const) {
					if (wanted !== taken) scope.warn(`${name} was set to ${wanted} but the descriptor reports ${taken}`);
				}
				const start = preamble.first_point >= 0 ? preamble.first_point : first_point;
				const stride = preamble.data_interval > 0 ? preamble.data_interval : interval;

				const scaleRaw = await session.query(':TIMebase:SCALe?');
				const timePerDiv = parseQuantity(scaleRaw)?.value ?? preamble.time_per_div;
				const enumerated = preamble.time_per_div;
				if (
					enumerated !== undefined &&
					timePerDiv !== undefined &&
					Math.abs(enumerated - timePerDiv) > enumerated * 1e-6
				) {
					scope.warn(
						`The waveform descriptor reports ${preamble.time_per_div} s/div, but the scope reports ${JSON.stringify(scaleRaw)}. The scope value is used`,
					);
				}
				const acquiredRaw = await session.query(':ACQuire:POINts?');
				const acquired = parseQuantity(acquiredRaw)?.value;
				const maxPoint = counted(':WAVeform:MAXPoint?')(await session.query(':WAVeform:MAXPoint?'));
				const maxPiece = typeof maxPoint === 'number' ? maxPoint : 0;

				if (points === 0 && acquired === undefined) {
					throw new ScpiError(
						`The acquired point count ${JSON.stringify(acquiredRaw)} is not usable, so the full record cannot be bounded. Set points to a positive value`,
					);
				}
				const total = points || Math.max(0, Math.ceil(((acquired ?? 0) - start) / stride));
				const bytesPerSample = width === 'WORD' ? 2 : 1;
				const piece = Math.max(1, Math.min(maxPiece || MAX_POINTS, Math.floor(MAX_PIECE_BYTES / bytesPerSample)));
				if (total * bytesPerSample > MAX_TRANSFER_BYTES || Math.ceil(total / piece) > MAX_PIECES) {
					throw new ScpiError(
						`${total} points exceed the ${MAX_TRANSFER_BYTES} byte or ${MAX_PIECES} piece transfer limit. Reduce points, raise first_point or raise interval`,
					);
				}
				if (acquired !== undefined && total < Math.ceil((acquired - start) / stride)) {
					scope.warn(
						`The record holds ${acquired} points and ${total} are transferred from index ${start}. Set points to zero for all points or raise interval to spread the transfer across the record`,
					);
				}

				const limit = output === 'summary' ? 0 : output === 'csv' ? MAX_CSV_POINTS : MAX_INLINE_POINTS;
				const decimation = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
				const kept: number[] = [];
				let transferred = 0;
				let pieces = 0;
				let bytes = 0;
				let min = Number.POSITIVE_INFINITY;
				let max = Number.NEGATIVE_INFINITY;
				let sum = 0;

				while (transferred < total) {
					const count = Math.min(total - transferred, piece);
					if (pieces > 0) await send(`:WAVeform:STARt ${start + transferred * stride}`);
					await send(`:WAVeform:POINt ${count}`);
					const payload = await session.queryBinary(':WAVeform:DATA?', timeout, samples);
					const read = Math.floor(payload.length / bytesPerSample);
					const code = codeAt(preamble, payload);
					for (let index = 0; index < read; index++) {
						const value = code(index);
						if (value < min) min = value;
						if (value > max) max = value;
						sum += value;
						if ((transferred + index) % decimation === 0 && kept.length < limit) kept.push(value);
					}
					pieces += 1;
					bytes += payload.length;
					transferred += read;
					if (read < count) break;
				}

				// The :WAVeform traffic engages the remote lock on its own (SDS1204X HD firmware 6.9.13.1.1.6.7), so the
				// panel is released after the transfer, unless the server runs with locking enabled and a lock may be
				// deliberate.
				if (!scope.allowLock) await send(':SYSTem:REMote OFF');

				const gain = preamble.vertical_gain * preamble.probe_attenuation;
				const offset = preamble.vertical_offset * preamble.probe_attenuation;
				const scale = preamble.code_per_div ? gain / preamble.code_per_div : undefined;
				if (scale === undefined) {
					scope.warn('The waveform scale is zero, so samples are returned as raw codes instead of incorrect voltages');
				}
				const volts = scale === undefined ? round : (code: number) => round(code * scale - offset);
				const divisions = Math.max(Math.abs(min), Math.abs(max)) / preamble.code_per_div;
				if (scale !== undefined && transferred > 0 && divisions > IMPLAUSIBLE_DIVISIONS) {
					scope.warn(
						`The samples span ${round(divisions)} divisions, which is outside the ADC range. Returned voltages may use an incorrect scale`,
					);
				}
				// sum_frames is the frame count that holds on hardware; read_frames has answered garbage on ordinary
				// transfers (1000, 0 and 500 for the same non-sequence signal on an SDS1204X HD).
				if (preamble.sum_frames > 1) {
					scope.warn(
						`The transfer contains ${preamble.sum_frames} sequence frames. Time values continue across frames instead of restarting`,
					);
				}

				const first = timePerDiv === undefined ? undefined : preamble.horizontal_offset - (timePerDiv * grid) / 2;
				const timeAt =
					first === undefined
						? undefined
						: (ordinal: number) => round(first + (start + ordinal * stride) * preamble.horizontal_interval);
				if (!timeAt) {
					scope.warn(
						`The timebase value ${JSON.stringify(scaleRaw)} is not usable, so points are returned without times`,
					);
				}
				const times = timeAt && kept.map((_, index) => timeAt(index * decimation));
				const header = scale === undefined ? 'code' : 'voltage';
				const series = kept.map(volts);

				return {
					source,
					commands,
					transfer: {
						requested: { first_point, points, interval },
						first_point: start,
						interval: stride,
						width,
						points: transferred,
						bytes,
						pieces,
						max_points_per_piece: maxPoint,
						acquired_points: acquired,
						...(sequence !== undefined && { sequence }),
					},
					preamble,
					scaling: {
						volts_per_division: round(gain),
						offset: round(offset),
						code_per_div: preamble.code_per_div,
						probe_attenuation: preamble.probe_attenuation,
						sample_bits: preamble.adc_bits,
						...(scope.capabilities?.resolution.bits && {
							adc_resolution_bits: scope.capabilities.resolution.bits,
						}),
						converted: scale !== undefined,
					},
					timing: {
						time_per_div: timePerDiv,
						horizontal_divisions: grid,
						delay: preamble.horizontal_offset,
						interval: preamble.horizontal_interval,
						...(timeAt && transferred > 0 && { first_time: timeAt(0), last_time: timeAt(transferred - 1) }),
					},
					frames: {
						index: preamble.frame_index,
						read: preamble.read_frames,
						acquired: preamble.sum_frames,
						...(preamble.read_frames !== preamble.sum_frames && {
							note: 'read is the raw descriptor value, which some firmware populates inconsistently. acquired is the frame count to trust',
						}),
					},
					summary: {
						count: transferred,
						...(transferred > 0 && {
							min: Math.min(volts(min), volts(max)),
							max: Math.max(volts(min), volts(max)),
							mean: volts(sum / transferred),
							min_code: min,
							max_code: max,
						}),
					},
					...(output === 'points' && { waveform: { ...(times && { time: times }), [header]: series, decimation } }),
					...(output === 'csv' && {
						csv: { points: series.length, decimation },
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
