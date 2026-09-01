import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { rootLog, setLogSink } from '../../../../src/observability.ts';
import { ScreenshotStore } from '../../../../src/screenshots.ts';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const bmp = (() => {
	const image = Buffer.alloc(54, 0x7f);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeInt32LE(800, 18);
	image.writeInt32LE(480, 22);
	image.writeUInt16LE(24, 28);
	image.writeUInt32LE(0, 30);
	return image;
})();

// The frame the SDS1204X HD answered on the bench: 32 bit, pixel data at offset 58, a negative height meaning
// top-down rows, and two linefeeds after the picture.
const topDown = (() => {
	const image = Buffer.alloc(58 + 4 * 2 * 4, 0x33);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeUInt32LE(58, 10);
	image.writeUInt32LE(40, 14);
	image.writeInt32LE(4, 18);
	image.writeInt32LE(-2, 22);
	image.writeUInt16LE(1, 26);
	image.writeUInt16LE(32, 28);
	image.writeUInt32LE(0, 30);
	return image;
})();

describe('EN11F root tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', {
			'*OPC?': '1',
			':FORMat:DATA?': 'CUSTom,5',
			':PRINt? BMP': bmp,
			':PRINt? BMP,INVerted': bmp,
		});
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('autosets and waits for completion only with the acknowledgement', async () => {
		await assertInvalidSendsNothing(harness, 'autoset_scope', {});
		await assertInvalidSendsNothing(harness, 'capture_screenshot', { invert: true });
		const autoset = payload(await call(harness, 'autoset_scope', { confirm_autoset: true }));
		expect(autoset.commands).toBeEqual([':AUToset']);
		expect(autoset.completed).toBeEqual({ completed: true, raw: '1' });
		assertSent(harness.fake, [':AUToset', '*OPC?']);
	});

	it('captures the screen as a BMP and reports its header', async () => {
		const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
		expect(shot.screenshot).toBeEqual({
			format: 'bmp',
			bytes: 54,
			width: 800,
			height: 480,
			bit_depth: 24,
			compression: 0,
		});
		assertSent(harness.fake, [':PRINt? BMP']);
		await assertReadOnly(harness.client, 'capture_screenshot');
	});

	it('asks for the inverted colour scheme with the guide second parameter', async () => {
		await call(harness, 'capture_screenshot', { inverted: true, include_image: false });
		assertSent(harness.fake, [':PRINt? BMP,INVerted']);
	});

	it('attaches the bitmap as an image content block when asked', async () => {
		const result = await call(harness, 'capture_screenshot', {});
		const blocks = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
		const image = blocks.find(({ type }) => type === 'image');
		expect(image?.mimeType).toBe('image/bmp');
		expect(image?.data).toBe(bmp.toString('base64'));
		harness.fake.sent();
	});

	it('reports the absolute height of a top-down frame and consumes its trailing linefeeds', async () => {
		harness.fake.replies.set(':PRINt? BMP', Buffer.concat([topDown, Buffer.from('\n\n')]));
		const lines: string[] = [];
		const level = rootLog.level;
		rootLog.level = 'warn';
		setLogSink((line) => lines.push(line));
		try {
			const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
			expect(shot.screenshot).toBeEqual({
				format: 'bmp',
				bytes: topDown.length,
				width: 4,
				height: 2,
				bit_depth: 32,
				compression: 0,
			});
			expect(lines.filter((line) => line.includes('trailing response bytes discarded'))).toBeEqual([]);
		} finally {
			rootLog.level = level;
			setLogSink((line) => void process.stderr.write(line));
			harness.fake.replies.set(':PRINt? BMP', bmp);
			harness.fake.sent();
		}
	});

	it('saves the capture through a screenshot store and names the file in the result', async () => {
		const base = mkdtempSync(join(tmpdir(), 'siglent-root-'));
		harness.scope.screenshots = new ScreenshotStore('bmp', 'SDS804X HD', base);
		try {
			const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
			const saved = String(shot.saved);
			expect(saved).toMatchRegex(/screenshot_\d{4}\.bmp$/);
			expect(readFileSync(saved)).toBeEqual(bmp);
			expect(shot.warnings).toBe(undefined);
		} finally {
			harness.scope.screenshots = undefined;
			rmSync(base, { recursive: true, force: true });
			harness.fake.sent();
		}
	});

	// The 54 byte fixture announces pixels it does not carry, so the PNG path refuses it and the BMP is kept.
	it('keeps the BMP and warns on the call when the picture cannot become a PNG', async () => {
		const base = mkdtempSync(join(tmpdir(), 'siglent-root-png-'));
		harness.scope.screenshots = new ScreenshotStore('png', 'SDS804X HD', base);
		try {
			const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
			expect(String(shot.saved)).toMatchRegex(/\.bmp$/);
			expect(String((shot.warnings as string[]).join())).toMatchRegex(/saved as BMP instead of PNG/);
		} finally {
			harness.scope.screenshots = undefined;
			rmSync(base, { recursive: true, force: true });
			harness.fake.sent();
		}
	});

	it('warns and still answers when the screenshot cannot be written', async () => {
		harness.scope.screenshots = new ScreenshotStore('bmp', 'SDS804X HD', '/dev/null/nowhere');
		try {
			const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
			expect(shot.saved).toBe(undefined);
			expect((shot.screenshot as { bytes: number }).bytes).toBe(54);
			expect(String((shot.warnings as string[]).join())).toMatchRegex(/screenshot was not saved/);
		} finally {
			harness.scope.screenshots = undefined;
			harness.fake.sent();
		}
	});

	it('refuses an answer that is not a bitmap', async () => {
		harness.fake.replies.set(':PRINt? BMP', Buffer.from('#800000004abcd', 'latin1'));
		const refused = await call(harness, 'capture_screenshot', { include_image: false });
		expect(refused.isError).toBe(true);
		harness.fake.replies.set(':PRINt? BMP', bmp);
		harness.fake.sent();
	});

	it('reads and sets the response precision', async () => {
		const read = payload(await call(harness, 'get_data_format'));
		expect(read).toBeEqual({ precision: 'CUSTom', digits: 5, raw: 'CUSTom,5' });
		assertSent(harness.fake, [':FORMat:DATA?']);

		const set = payload(await call(harness, 'configure_data_format', { precision: 'CUSTom', digits: 5 }));
		expect(set.commands).toBeEqual([':FORMat:DATA CUSTom,5']);
		assertSent(harness.fake, [':FORMat:DATA CUSTom,5', ':FORMat:DATA?']);
	});

	it('warns when the scope reports a precision other than the one requested', async () => {
		const set = payload(await call(harness, 'configure_data_format', { precision: 'DOUBle' }));
		expect(set.commands).toBeEqual([':FORMat:DATA DOUBle']);
		expect(String((set.warnings as string[])[0])).toMatchRegex(/DOUBle but the scope reports/);
		harness.fake.sent();
	});

	// digits belongs to CUSTom: a bare SINGle with digits, or a CUSTom without them, is refused before the write.
	it('validates the precision pair before anything is sent', async () => {
		await assertInvalidSendsNothing(harness, 'configure_data_format', { precision: 'CUSTom' });
		await assertInvalidSendsNothing(harness, 'configure_data_format', { precision: 'SINGle', digits: 7 });
		await assertInvalidSendsNothing(harness, 'configure_data_format', { precision: 'CUSTom', digits: 65 });
		await assertInvalidSendsNothing(harness, 'configure_data_format', { precision: 'HALF' });
	});
});
