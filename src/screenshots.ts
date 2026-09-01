import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const screenshotFormats = ['png', 'bmp'] as const;
export type ScreenshotFormat = (typeof screenshotFormats)[number];

const two = (value: number): string => String(value).padStart(2, '0');
const clock = (at: Date): string => `${two(at.getHours())}${two(at.getMinutes())}`;
const day = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
const sanitize = (model: string): string => model.replace(/[^A-Za-z0-9.-]+/g, '-');

// Writes every capture into one session directory, created lazily on the first capture and never overwriting a file.
export class ScreenshotStore {
	readonly #format: ScreenshotFormat;
	readonly #directory: string;
	readonly #now: () => Date;

	constructor(format: ScreenshotFormat, model: string, root = '.', now: () => Date = () => new Date()) {
		this.#format = format;
		this.#now = now;
		const started = now();
		this.#directory = join(root, `${day(started)}T${clock(started)}_${sanitize(model)}`);
	}

	save(payload: Buffer, warn: (message: string) => void): string | undefined {
		let data = payload;
		let extension: string = this.#format;
		if (this.#format === 'png') {
			try {
				data = pngFromBmp(payload);
			} catch (cause) {
				warn(`The screenshot was saved as BMP instead of PNG: ${message(cause)}`);
				extension = 'bmp';
			}
		}
		try {
			mkdirSync(this.#directory, { recursive: true });
			return this.#write(`screenshot_${clock(this.#now())}`, extension, data);
		} catch (cause) {
			warn(`The screenshot was not saved: ${message(cause)}`);
			return undefined;
		}
	}

	#write(base: string, extension: string, data: Buffer): string {
		for (let attempt = 1; ; attempt++) {
			const path = join(this.#directory, `${base}${attempt > 1 ? `_${attempt}` : ''}.${extension}`);
			try {
				writeFileSync(path, data, { flag: 'wx' });
				return path;
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
			}
		}
	}
}

const SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

// The observed SDS1204X HD picture is uncompressed 32 bit BGRA with a negative height meaning top-down rows. 24 bit
// and bottom-up frames are the plausible siblings. The fourth byte of an uncompressed 32 bit pixel is unused, so
// every pixel becomes plain RGB.
export function pngFromBmp(bmp: Buffer): Buffer {
	if (bmp.length < 54 || bmp.toString('ascii', 0, 2) !== 'BM') throw new Error('the payload is not a BMP');
	const offset = bmp.readUInt32LE(10);
	const width = bmp.readInt32LE(18);
	const signedHeight = bmp.readInt32LE(22);
	const depth = bmp.readUInt16LE(28);
	const compression = bmp.readUInt32LE(30);
	const height = Math.abs(signedHeight);
	if (width <= 0 || height === 0 || compression !== 0 || (depth !== 24 && depth !== 32)) {
		throw new Error(`unsupported BMP variant, ${width}x${signedHeight}, ${depth} bit, compression ${compression}`);
	}
	const bytesPerPixel = depth / 8;
	const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
	if (offset < 54 || offset + stride * height > bmp.length) throw new Error('the BMP pixel data is truncated');
	const scanlines = Buffer.alloc(height * (1 + width * 3));
	let out = 0;
	for (let line = 0; line < height; line++) {
		let source = offset + (signedHeight < 0 ? line : height - 1 - line) * stride;
		out++;
		for (let x = 0; x < width; x++, source += bytesPerPixel) {
			scanlines[out++] = bmp[source + 2] ?? 0;
			scanlines[out++] = bmp[source + 1] ?? 0;
			scanlines[out++] = bmp[source] ?? 0;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND')]);
}

function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
	const framed = Buffer.alloc(data.length + 12);
	framed.writeUInt32BE(data.length, 0);
	framed.write(type, 4, 'ascii');
	data.copy(framed, 8);
	framed.writeUInt32BE(crc32(framed.subarray(4, framed.length - 4)), framed.length - 4);
	return framed;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
