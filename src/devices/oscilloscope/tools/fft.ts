import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, parseState } from '../../../scpi/values.ts';
import { applied, clamped, compare, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Channel, Scope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { readDefinition } from './math.ts';
import { channel, hertz, volts } from './schema.ts';

const units = ['VRMS', 'DBM', 'DBVRMS'] as const;
const modes = ['OFF', 'ON', 'EXCLU'] as const;
const windows = ['RECT', 'BLAC', 'HANN', 'HAMM', 'FLATTOP'] as const;

type Unit = (typeof units)[number];

// Vrms takes the whole set, dBm and dBVrms only 0.1 and up (pp. 107-108).
const scales = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20] as const;
const decibel = scales.filter((value) => value >= 0.1);
const allowed = (unit: Unit): readonly number[] => (unit === 'VRMS' ? scales : decibel);

// Row order is the send order: the scale and the offset are read in the scale type, so FFTU goes first (pp. 105-108).
const params = [
	param('scale_unit', 'FFTU', z.enum(units), 'Vertical scale type. The scale and offset use this unit.', (raw) =>
		asState(raw, units),
	),
	param(
		'vertical_scale',
		'FFTS',
		z.literal(scales),
		'Vertical scale per division. DBM and DBVRMS support values from 0.1 and above.',
		asQuantity,
	),
	clamped(
		'vertical_position',
		'FFTP',
		volts,
		'Vertical offset from -24.4 to 15.6 divisions of the current scale. Available only with the VRMS scale type.',
		asQuantity,
		1e-6,
	),
	clamped(
		'center_frequency',
		'FFTC',
		hertz,
		'Center frequency. The allowed range follows the horizontal scale and varies by model.',
		asQuantity,
		1,
	),
	param('display_mode', 'FFTF', z.enum(modes), 'OFF split screen, ON full screen, EXCLU exclusive', (raw) =>
		asState(raw, modes),
	),
	param('window', 'FFTW', z.enum(windows), 'window function: rectangle, Blackman, Hanning, Hamming or flattop', (raw) =>
		asState(raw, windows),
	),
];

// Both the center frequency and the offset are clamped to the nearest legal value, which depends on the model (pp. 102, 105).
const clamping = params.filter((p) => p.floor !== undefined);

// The guide gives an availability table for these three and for FFTT?; FFTS, FFTF and FFTW carry none.
const exclusive = new Set(['FFTU', 'FFTP', 'FFTC']);
const universal = params.filter((p) => !exclusive.has(p.mnemonic));

const availableXe = (scope: Scope): boolean => (scope.capabilities?.features.xe ?? 'unknown') !== 'unsupported';
const named = (scope: Scope) => scope.identity?.model ?? 'The scope';

interface FftInput extends Values {
	source?: Channel;
	scale_unit?: Unit;
	vertical_scale?: number;
	vertical_position?: string;
	center_frequency?: string;
}

// `only` limits the read-back to what a request set; without it the whole FFT is read. The horizontal scale follows
// the center frequency, so FFTT? travels with it.
async function readFft(session: ScpiSession, xe: boolean, only?: Values): Promise<Values> {
	const rows = xe ? params : universal;
	const horizontal = xe && (only === undefined || only.center_frequency !== undefined);
	return {
		...(only && only.source === undefined ? {} : await readDefinition(session)),
		...(await readback(session, only ? applied(rows, only) : rows)),
		...(horizontal ? { horizontal_scale: asQuantity(await session.query('FFTT?')) } : {}),
	};
}

async function requireFftOperation(session: ScpiSession, scope: Scope): Promise<void> {
	const { operation, equation_raw } = await readDefinition(session);
	if (operation === undefined) {
		scope.warn(
			`The math operation response ${JSON.stringify(equation_raw)} was not recognized. FFT settings were sent unchecked.`,
		);
	} else if (operation !== 'fft') {
		throw new Error(
			`The current math operation is ${operation}, not FFT. Provide source to switch the operation to FFT.`,
		);
	}
}

const fits = (unit: Unit, input: FftInput): boolean =>
	(input.vertical_scale === undefined || allowed(unit).includes(input.vertical_scale)) &&
	(input.vertical_position === undefined || unit === 'VRMS');

// The scale type in the request is checked by the schema; only the one the scope already holds is read here.
async function guard(session: ScpiSession, scope: Scope, input: FftInput, xe: boolean): Promise<void> {
	if (input.source === undefined) await requireFftOperation(session, scope);
	const dependent = input.vertical_scale !== undefined || input.vertical_position !== undefined;
	if (!dependent || input.scale_unit !== undefined) return;
	if (!xe) {
		scope.warn('The FFT scale type cannot be read on this model. The vertical scale was sent unchecked.');
		return;
	}
	const raw = await session.query('FFTU?');
	const unit = parseState(raw, units);
	if (unit === undefined) {
		scope.warn(
			`The FFT scale type response ${JSON.stringify(raw)} was not recognized. Vertical settings were sent unchecked.`,
		);
	} else if (!fits(unit, input)) {
		throw new Error(
			`The current scale type is ${unit}. It supports vertical scales ${allowed(unit).join(', ')}${unit === 'VRMS' ? '' : ' and does not support vertical position'}. Provide a compatible scale_unit in the same request.`,
		);
	}
}

export const fftTools = [
	tool({
		name: 'get_fft',
		description:
			'Read the FFT operation, source, scale type, vertical scale, vertical offset, center frequency, display mode, window, and horizontal scale in hertz per division. Scale type, vertical offset, center frequency, and horizontal scale are available only on SDS1000X-E.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				const xe = availableXe(scope);
				if (!xe) {
					scope.warn(
						`${named(scope)} does not support reading FFT center frequency, vertical offset, horizontal scale, or scale type.`,
					);
				}
				return readFft(session, xe);
			}),
	}),
	tool({
		name: 'configure_fft',
		description:
			'Configure the FFT waveform. Providing a source switches the math operation to FFT. Without a source, the current operation must already be FFT. DBM and DBVRMS scale types support vertical scales from 0.1 and above. Vertical position requires VRMS. Scale type, vertical position, and center frequency are available only on SDS1000X-E. The scope may clamp center frequency or vertical position.',
		input: z
			.object({
				source: channel.optional().describe('Channel used as the FFT source.'),
				...inputs(params),
			})
			.refine((input: FftInput) => input.scale_unit === undefined || fits(input.scale_unit, input), {
				message: `DBM and DBVRMS support vertical scales ${decibel.join(', ')} and do not support vertical position. Choose a compatible scale or use VRMS.`,
				path: ['scale_unit'],
			}),
		annotations: mutating,
		handler: (input: FftInput, scope) => {
			const commands = plan(input.source && `DEF EQN,'FFT${input.source}'`, ...settings(params, input));
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (input.source) scope.requireChannel(input.source);
				const xe = availableXe(scope);
				if (params.some((p) => exclusive.has(p.mnemonic) && input[p.name] !== undefined)) scope.requireSupport('xe');
				await guard(session, scope, input, xe);
				for (const command of commands) await session.command(command);
				const state = await readFft(session, xe, input as Values);
				compare(scope, clamping, input, state, 'the legal range depends on the scale and the model');
				return { commands, state };
			});
		},
	}),
];
