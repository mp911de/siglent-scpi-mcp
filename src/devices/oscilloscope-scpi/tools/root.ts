import * as z from 'zod';
import { announcedLength, type FrameReader, readBinary } from '../../../scpi/codec.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { timeoutMs } from '../../../tools/schema.ts';
import { counted } from '../scope.ts';
import { waitUntilComplete } from './common.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const AUTOSET_TIMEOUT = 15_000;
const SCREENSHOT_TIMEOUT = 20_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

const precisions = ['SINGle', 'DOUBle', 'CUSTom'] as const;

// The answer declares its own length in its BMP header, so a picture larger than this tool promises is refused there
// rather than buffered up to the connection's much larger ceiling. The linefeeds after the picture belong to this
// answer rather than the next one (two observed on the SDS1204X HD).
const bounded: FrameReader = (buffer) => {
	const declared = announcedLength(buffer);
	if (declared !== undefined && declared > MAX_SCREENSHOT_BYTES) {
		throw new ScpiError(`The screenshot is ${declared} bytes, exceeding the ${MAX_SCREENSHOT_BYTES} byte limit`);
	}
	const frame = readBinary(buffer);
	if (!frame) return undefined;
	let { end } = frame;
	while (buffer[end] === LF || buffer[end] === CR) end++;
	return { payload: frame.payload, end };
};

function bitmap(payload: Buffer) {
	if (payload.length < 54 || payload.toString('ascii', 0, 2) !== 'BM') {
		throw new ScpiError(
			`The screenshot is not a BMP. It contains ${payload.length} bytes starting with ${payload.toString('hex', 0, 4)}`,
		);
	}
	// A negative height means top-down rows, a storage detail the reported size keeps out of the public shape.
	return {
		bytes: payload.length,
		width: payload.readInt32LE(18),
		height: Math.abs(payload.readInt32LE(22)),
		bit_depth: payload.readUInt16LE(28),
		compression: payload.readUInt32LE(30),
	};
}

async function readFormat(session: ScpiSession) {
	const raw = await session.query(':FORMat:DATA?');
	const [precision, digits] = raw.trim().split(',');
	return { precision, digits: digits === undefined ? undefined : counted('digits')(digits), raw };
}

export const rootTools = [
	tool({
		name: 'autoset_scope',
		description:
			'Automatically adjust the vertical scale, timebase and trigger to display the input signals, then wait for completion. Signals below 100 Hz may not produce useful settings. Requires confirm_autoset: true. Nothing is sent otherwise.',
		input: z.object({
			confirm_autoset: z
				.literal(true)
				.describe('Explicit acknowledgement that channel, timebase and trigger settings change'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 15000'),
		}),
		annotations: destructive,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				await session.command(':AUToset');
				return { commands: [':AUToset'], completed: await waitUntilComplete(session, timeout_ms ?? AUTOSET_TIMEOUT) };
			}),
	}),
	tool({
		name: 'capture_screenshot',
		description:
			'Capture the screen as a BMP image. Transfers are limited to 8 MiB and 20 seconds by default. Some MCP clients cannot display BMP images. Set include_image to false to return header metadata only.',
		input: z.strictObject({
			inverted: z.boolean().default(false).describe('Use the inverted colour scheme'),
			include_image: z
				.boolean()
				.default(true)
				.describe('Attach the BMP as an image content block. False returns header metadata only'),
			timeout_ms: timeoutMs.describe('Transfer timeout in milliseconds, default 20000'),
		}),
		annotations: readOnly,
		exposure: 'screenshots',
		handler: ({ inverted, include_image, timeout_ms }, scope) =>
			scope.execute(async (session) => {
				const command = inverted ? ':PRINt? BMP,INVerted' : ':PRINt? BMP';
				const payload = await session.queryBinary(command, timeout_ms ?? SCREENSHOT_TIMEOUT, bounded);
				const screenshot = { format: 'bmp', ...bitmap(payload) };
				const saved = scope.screenshots?.save(payload, (reason) => scope.warn(reason));
				return {
					screenshot,
					...(saved && { saved }),
					...(include_image && {
						content: [{ type: 'image' as const, mimeType: 'image/bmp', data: payload.toString('base64') }],
					}),
				};
			}),
	}),
	tool({
		name: 'get_data_format',
		description: 'Read the precision used for numeric responses.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute(readFormat),
	}),
	tool({
		name: 'configure_data_format',
		description:
			'Set the precision of numeric responses. Single uses 7 significant digits, Double uses 14 and Custom uses 1 to 64. This setting is shared by every client connected to the scope.',
		input: z
			.object({
				precision: z.enum(precisions).describe('Precision of returned numbers'),
				digits: z.number().int().min(1).max(64).optional().describe('Significant digits. Custom precision only.'),
			})
			.refine(({ precision, digits }) => (precision === 'CUSTom') === (digits !== undefined), {
				message: 'Custom precision requires digits. Remove digits or set precision to Custom',
				path: ['digits'],
			}),
		annotations: mutating,
		handler: ({ precision, digits }, scope) =>
			scope.execute(async (session) => {
				const command = `:FORMat:DATA ${precision}${digits === undefined ? '' : `,${digits}`}`;
				await session.command(command);
				const state = await readFormat(session);
				if (state.precision?.toUpperCase() !== precision.toUpperCase()) {
					scope.warn(`precision was set to ${precision} but the scope reports ${JSON.stringify(state.raw)}`);
				}
				return { commands: [command], state };
			}),
	}),
];
