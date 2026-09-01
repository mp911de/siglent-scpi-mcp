import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { expect } from '@assertive-ts/core';
import { ScreenshotStore } from '../src/screenshots.ts';

const roots: string[] = [];

function root(): string {
	const created = mkdtempSync(join(tmpdir(), 'siglent-screenshots-'));
	roots.push(created);
	return created;
}

after(() => {
	for (const created of roots) rmSync(created, { recursive: true, force: true });
});

const at = (hours: number, minutes: number) => () => new Date(2026, 8, 1, hours, minutes);

// Pixel (x, y) counts from the top-left corner, whichever row order the BMP stores.
const red = (x: number, y: number): [number, number, number] => [x * 40 + 10, y * 40 + 20, x + y];

function bmp(width: number, signedHeight: number, depth: 24 | 32, offset = 54): Buffer {
	const height = Math.abs(signedHeight);
	const bytes = depth / 8;
	const stride = Math.ceil((width * bytes) / 4) * 4;
	const image = Buffer.alloc(offset + stride * height);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeUInt32LE(offset, 10);
	image.writeUInt32LE(40, 14);
	image.writeInt32LE(width, 18);
	image.writeInt32LE(signedHeight, 22);
	image.writeUInt16LE(1, 26);
	image.writeUInt16LE(depth, 28);
	for (let y = 0; y < height; y++) {
		const row = signedHeight < 0 ? y : height - 1 - y;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = red(x, y);
			const pixel = offset + row * stride + x * bytes;
			image[pixel] = b;
			image[pixel + 1] = g;
			image[pixel + 2] = r;
		}
	}
	return image;
}

function png(path: string) {
	const data = readFileSync(path);
	expect([...data.subarray(0, 8)]).toBeEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const chunks = new Map<string, Buffer[]>();
	for (let index = 8; index < data.length; index += data.readUInt32BE(index) + 12) {
		const type = data.toString('ascii', index + 4, index + 8);
		const payload = data.subarray(index + 8, index + 8 + data.readUInt32BE(index));
		chunks.set(type, [...(chunks.get(type) ?? []), payload]);
	}
	const header = chunks.get('IHDR')?.[0];
	expect(header).toBeTruthy();
	expect(chunks.has('IEND')).toBeTruthy();
	if (!header) throw new Error('The IHDR assertion did not throw');
	const width = header.readUInt32BE(0);
	const raster = inflateSync(Buffer.concat(chunks.get('IDAT') ?? []));
	return {
		width,
		height: header.readUInt32BE(4),
		bitDepth: header[8],
		colorType: header[9],
		pixel(x: number, y: number): number[] {
			const stride = 1 + width * 3;
			expect(raster[y * stride]).toBe(0);
			return [...raster.subarray(y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3)];
		},
	};
}

const silent = () => expect(false).toBeTrue();

describe('screenshot store', () => {
	it('names the session directory from the start time and the sanitized model', () => {
		const base = root();
		const store = new ScreenshotStore('bmp', 'SDS 1204X/HD (v2)', base, at(14, 21));
		const image = bmp(2, 2, 24);
		const saved = store.save(image, silent);
		expect(saved).toBe(join(base, '2026-09-01T1421_SDS-1204X-HD-v2-', 'screenshot_1421.bmp'));
		expect(readFileSync(saved ?? '') as Buffer<ArrayBufferLike>).toBeEqual(image);
	});

	it('creates nothing before the first capture and counts up instead of overwriting', () => {
		const base = root();
		const store = new ScreenshotStore('bmp', 'SDS1204X HD', base, at(9, 5));
		expect(readdirSync(base)).toBeEqual([]);
		const image = bmp(2, 2, 24);
		for (let capture = 0; capture < 3; capture++) store.save(image, silent);
		expect(readdirSync(join(base, '2026-09-01T0905_SDS1204X-HD')).sort()).toBeEqual([
			'screenshot_0905.bmp',
			'screenshot_0905_2.bmp',
			'screenshot_0905_3.bmp',
		]);
	});

	it('transcodes the observed 32 bit top-down frame at offset 58 to PNG', () => {
		const store = new ScreenshotStore('png', 'SDS1204X HD', root(), at(14, 21));
		const saved = store.save(bmp(4, -3, 32, 58), silent);
		const image = png(saved ?? '');
		expect(image.width).toBe(4);
		expect(image.height).toBe(3);
		expect(image.bitDepth).toBe(8);
		expect(image.colorType).toBe(2);
		expect(image.pixel(0, 0)).toBeEqual(red(0, 0));
		expect(image.pixel(3, 2)).toBeEqual(red(3, 2));
	});

	it('transcodes a 24 bit bottom-up frame with padded rows to PNG', () => {
		const store = new ScreenshotStore('png', 'SDS1204X HD', root(), at(14, 21));
		const saved = store.save(bmp(3, 2, 24), silent);
		const image = png(saved ?? '');
		expect(image.width).toBe(3);
		expect(image.height).toBe(2);
		expect(image.pixel(0, 0)).toBeEqual(red(0, 0));
		expect(image.pixel(2, 1)).toBeEqual(red(2, 1));
	});

	it('keeps an unsupported variant as the BMP it arrived as, with a warning', () => {
		const store = new ScreenshotStore('png', 'SDS1204X HD', root(), at(14, 21));
		const compressed = bmp(2, 2, 24);
		compressed.writeUInt32LE(1, 30);
		const warnings: string[] = [];
		const saved = store.save(compressed, (message) => warnings.push(message));
		expect(saved ?? '').toMatchRegex(/screenshot_1421\.bmp$/);
		expect(readFileSync(saved ?? '') as Buffer<ArrayBufferLike>).toBeEqual(compressed);
		expect(warnings.join()).toMatchRegex(/saved as BMP instead of PNG.*compression 1/);
	});

	it('warns instead of failing when the file cannot be written', () => {
		const base = root();
		writeFileSync(join(base, 'blocked'), 'not a directory');
		const store = new ScreenshotStore('png', 'SDS1204X HD', join(base, 'blocked'), at(14, 21));
		const warnings: string[] = [];
		const saved = store.save(bmp(2, 2, 24), (message) => warnings.push(message));
		expect(saved).toBe(undefined);
		expect(warnings.join()).toMatchRegex(/screenshot was not saved/);
	});
});
