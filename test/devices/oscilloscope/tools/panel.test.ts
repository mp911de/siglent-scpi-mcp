import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { ScreenshotStore } from '../../../../src/screenshots.ts';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const setupXml = '<?xml version="1.0"?><PanelSetup><Channel/></PanelSetup>';
const setupBlock = Buffer.from(`#9${String(setupXml.length).padStart(9, '0')}${setupXml}`, 'latin1');
const setupSha = createHash('sha256').update(Buffer.from(setupXml, 'latin1')).digest('hex');

function bmp(width = 8, height = 4, bits = 24): Buffer {
	const image = Buffer.alloc(54 + width * height * (bits / 8), 0x7f);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeUInt32LE(54, 10);
	image.writeUInt32LE(40, 14);
	image.writeInt32LE(width, 18);
	image.writeInt32LE(height, 22);
	image.writeUInt16LE(1, 26);
	image.writeUInt16LE(bits, 28);
	image.writeUInt32LE(0, 30);
	return image;
}

const screen = bmp();

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

type Result = Parameters<typeof payload>[0];

const blocks = (result: Result) => result.content as Array<Record<string, unknown>>;
const warnings = (result: Result) => (payload(result).warnings ?? []) as string[];

async function connect(replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('panel tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ SCDP: screen, 'PNSU?': setupBlock, '*OPC?': '1', 'CHDR?': 'OFF' });
	});

	after(() => harness.close());

	it('captures the screen as a BMP image block plus its header metadata', async () => {
		const result = await call(harness, 'capture_screenshot');
		expect(payload(result).screenshot).toBeEqual({
			format: 'bmp',
			bytes: screen.length,
			width: 8,
			height: 4,
			bits_per_pixel: 24,
			compression: 0,
		});
		expect(blocks(result)[1]).toBeEqual({
			type: 'image',
			mimeType: 'image/bmp',
			data: screen.toString('base64'),
		});
		assertSent(harness.fake, ['SCDP']);
		await assertReadOnly(harness.client, 'capture_screenshot');
	});

	it('leaves the image out when it is not asked for', async () => {
		const result = await call(harness, 'capture_screenshot', { include_image: false });
		expect(blocks(result).length).toBe(1);
		expect((payload(result).screenshot as { bytes: number }).bytes).toBe(screen.length);
		assertSent(harness.fake, ['SCDP']);
	});

	it('saves the capture through a screenshot store and names the file in the result', async () => {
		const base = mkdtempSync(join(tmpdir(), 'siglent-panel-'));
		harness.scope.screenshots = new ScreenshotStore('bmp', 'SDS1104X-E', base);
		try {
			const shot = payload(await call(harness, 'capture_screenshot', { include_image: false }));
			const saved = String(shot.saved);
			expect(saved).toMatchRegex(/screenshot_\d{4}\.bmp$/);
			expect(readFileSync(saved) as Buffer<ArrayBufferLike>).toBeEqual(screen);
		} finally {
			harness.scope.screenshots = undefined;
			rmSync(base, { recursive: true, force: true });
			harness.fake.sent();
		}
	});

	it('captures a panel setup as metadata only and keeps the payload in the server', async () => {
		const result = await call(harness, 'capture_panel_setup');
		const setup = payload(result).setup as Record<string, unknown>;
		expect(setup.format).toBe('xml');
		expect(setup.bytes).toBe(setupXml.length);
		expect(setup.sha256).toBe(setupSha);
		expect(setup.model).toBe('SDS1104X-E');
		expect(String(setup.id)).toMatchRegex(/^setup-[\w-]{12}$/);
		expect(blocks(result).length).toBe(1);
		assertSent(harness.fake, ['PNSU?']);
		await assertReadOnly(harness.client, 'capture_panel_setup');
	});

	it('hands out a fresh unguessable id for every capture', async () => {
		const first = payload(await call(harness, 'capture_panel_setup')).setup as { id: string };
		const second = payload(await call(harness, 'capture_panel_setup')).setup as { id: string };
		expect(first.id).not.toBe(second.id);
		expect(second.id).toMatchRegex(/^setup-[\w-]{12}$/);
		harness.fake.sent();
	});

	it('drops the oldest capture once it keeps more than eight', async () => {
		const ids: string[] = [];
		for (let capture = 0; capture < 9; capture++) {
			ids.push((payload(await call(harness, 'capture_panel_setup')).setup as { id: string }).id);
		}
		harness.fake.sent();
		const result = await call(harness, 'restore_panel_setup', { setup_id: ids[0], confirm_restore: true });
		expect(String(payload(result).error)).toMatchRegex(/Unknown setup/);
		assertSent(harness.fake, []);
	});

	it('attaches the setup as an embedded resource on request', async () => {
		const result = await call(harness, 'capture_panel_setup', { include_payload: true });
		const { id } = payload(result).setup as { id: string };
		expect(blocks(result)[1]).toBeEqual({
			type: 'resource',
			resource: { uri: `siglent://panel-setup/${id}`, mimeType: 'application/xml', text: setupXml },
		});
		harness.fake.sent();
	});

	it('warns about a capture timeout below the recommended 10 s', async () => {
		const result = await call(harness, 'capture_panel_setup', { timeout_ms: 400 });
		expect(warnings(result).some((warning) => warning.includes('at least 10000 ms'))).toBeTruthy();
		harness.fake.sent();
	});

	it('rejects an empty setup block', async () => {
		harness.fake.replies.set('PNSU?', Buffer.from('#9000000000', 'latin1'));
		try {
			const result = await call(harness, 'capture_panel_setup');
			expect(result.isError).toBe(true);
			expect(JSON.parse((blocks(result)[0] as { text: string }).text).kind).toBe('scpi');
		} finally {
			harness.fake.replies.set('PNSU?', setupBlock);
			harness.fake.sent();
		}
	});

	it('restores a captured setup as a definite-length block and re-identifies', async () => {
		const { id } = payload(await call(harness, 'capture_panel_setup')).setup as { id: string };
		harness.fake.sent();
		const result = await call(harness, 'restore_panel_setup', { setup_id: id, confirm_restore: true });
		expect((payload(result).setup as { id: string }).id).toBe(id);
		expect(payload(result).commands).toBeEqual([`PNSU ${setupBlock.toString('latin1', 0, 11)}`]);
		expect((payload(result).identity as { model: string }).model).toBe('SDS1104X-E');
		assertSent(harness.fake, [`PNSU ${setupBlock.toString('latin1')}`, '*OPC?', 'CHDR OFF', '*IDN?']);
	});

	it('refuses a setup id it did not hand out', async () => {
		const unknown = 'setup-AAAAAAAAAAAA';
		const result = await assertInvalidSendsNothing(harness, 'restore_panel_setup', {
			setup_id: unknown,
			confirm_restore: true,
		});
		expect(JSON.parse((blocks(result)[0] as { text: string }).text).error as string).toMatchRegex(
			new RegExp(`Unknown setup ${unknown}`),
		);
	});

	it('saves to an internal slot and to a USB file', async () => {
		await call(harness, 'save_panel_setup', { slot: 3, confirm_overwrite: true });
		assertSent(harness.fake, ['*SAV 3', '*OPC?']);
		await call(harness, 'save_panel_setup', { usb: { file: 'TEST' }, confirm_overwrite: true });
		assertSent(harness.fake, ["STPN DISK,UDSK,FILE,'TEST.xml'", '*OPC?']);
		await call(harness, 'save_panel_setup', {
			usb: { file: 'TEST-01', directory: ['SAVE', 'PANEL'] },
			confirm_overwrite: true,
		});
		assertSent(harness.fake, ["STPN DISK,UDSK,FILE,'/SAVE/PANEL/TEST-01.xml'", '*OPC?']);
	});

	it('recalls an internal slot and a USB file, then re-identifies', async () => {
		await call(harness, 'recall_panel_setup', { slot: 0, confirm_recall: true });
		assertSent(harness.fake, ['*RCL 0', '*OPC?', 'CHDR OFF', '*IDN?']);
		await call(harness, 'recall_panel_setup', { usb: { file: 'TEST' }, confirm_recall: true });
		assertSent(harness.fake, ["RCPN DISK,UDSK,FILE,'TEST.xml'", '*OPC?', 'CHDR OFF', '*IDN?']);
	});

	it('sends nothing for a request the schema rejects', async () => {
		await assertInvalidSendsNothing(harness, 'restore_panel_setup', { setup_id: 'setup-AAAAAAAAAAAA' });
		await assertInvalidSendsNothing(harness, 'restore_panel_setup', { setup_id: 'setup-1', confirm_restore: true });
		await assertInvalidSendsNothing(harness, 'restore_panel_setup', { setup_id: '../etc', confirm_restore: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { slot: 0, confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { slot: 21, confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', {
			slot: 3,
			usb: { file: 'TEST' },
			confirm_overwrite: true,
		});
		await assertInvalidSendsNothing(harness, 'recall_panel_setup', { slot: 21, confirm_recall: true });
		await assertInvalidSendsNothing(harness, 'recall_panel_setup', { slot: 1 });
	});

	it('keeps path traversal and the command grammar out of a file name', async () => {
		for (const file of ['../TEST', 'TE ST', "TE'ST", 'TE,ST', 'TE;ST', 'TEST.xml', 'TOOLONGNAME', 'TE\nST', '']) {
			await assertInvalidSendsNothing(harness, 'save_panel_setup', { usb: { file }, confirm_overwrite: true });
		}
		for (const directory of [['..'], ['/SAVE'], ['SA,VE'], ['A', 'B', 'C', 'D', 'E']]) {
			await assertInvalidSendsNothing(harness, 'save_panel_setup', {
				usb: { file: 'TEST', directory },
				confirm_overwrite: true,
			});
		}
	});
});

describe('panel tools on other families', () => {
	it('uses the .set extension outside SDS1000X-E', async () => {
		const harness = await connect({ '*OPC?': '1' }, 'SDS2104X');
		await call(harness, 'save_panel_setup', { usb: { file: 'TEST' }, confirm_overwrite: true });
		assertSent(harness.fake, ["STPN DISK,UDSK,FILE,'TEST.set'", '*OPC?']);
		await harness.close();
	});

	it('warns and assumes .set for a model the guide does not list', async () => {
		const harness = await connect({ '*OPC?': '1' }, 'SDS9999Z');
		const result = await call(harness, 'save_panel_setup', { usb: { file: 'TEST' }, confirm_overwrite: true });
		expect(warnings(result).some((warning) => /unknown setup-file extension.*Using \.set/i.test(warning))).toBeTruthy();
		assertSent(harness.fake, ["STPN DISK,UDSK,FILE,'TEST.set'", '*OPC?']);
		await harness.close();
	});

	it('sends nothing to a newer-dialect model', async () => {
		const harness = await connect({}, 'SDS2104X Plus');
		assertCapabilityError(await call(harness, 'capture_screenshot'), 'SDS2104X Plus');
		assertCapabilityError(await call(harness, 'capture_panel_setup'), 'SDS2104X Plus');
		assertCapabilityError(await call(harness, 'save_panel_setup', { slot: 1, confirm_overwrite: true }), 'SDS');
		assertCapabilityError(await call(harness, 'recall_panel_setup', { slot: 1, confirm_recall: true }), 'SDS');
		assertSent(harness.fake, []);
		await harness.close();
	});
});

describe('panel tools bounds and guards', () => {
	it('refuses the screenshot instead of framing a reply the communication header prefixes', async () => {
		const harness = await connect({ SCDP: screen, 'CHDR?': 'SHORT' });
		try {
			await call(harness, 'configure_communication_header', { mode: 'SHORT' });
			harness.fake.sent();
			const result = await call(harness, 'capture_screenshot');
			expect(result.isError).toBe(true);
			expect(String(payload(result).error)).toMatchRegex(/communication header is SHORT/);
			assertSent(harness.fake, []);
		} finally {
			await harness.close();
		}
	});

	it('refuses a bitmap that announces more bytes than the screenshot limit', async () => {
		const huge = Buffer.from(screen);
		huge.writeUInt32LE(64 * 1024 * 1024, 2);
		const harness = await connect({ SCDP: huge });
		try {
			const result = await call(harness, 'capture_screenshot');
			expect(result.isError).toBe(true);
			expect(payload(result).kind).toBe('scpi');
			expect(String(payload(result).error)).toMatchRegex(
				/screenshot is 67108864 bytes, exceeding the 4194304 byte limit/i,
			);
			expect(harness.scope.connected).toBe(false);
		} finally {
			await harness.close();
		}
	});

	// The connection accepts a 9-digit block header up to a gigabyte, so a per-tool ceiling that only looks at the BMP
	// form leaves the other framing bounded by nothing the tool description mentions.
	it('refuses a block that announces more bytes than the per-tool limit, in either framing', async () => {
		const header = (bytes: number) => Buffer.from(`#9${String(bytes).padStart(9, '0')}`, 'latin1');
		const screenshot = await connect({ SCDP: header(64 * 1024 * 1024) });
		const setup = await connect({ 'PNSU?': header(999_999_999) });
		try {
			const shot = await call(screenshot, 'capture_screenshot');
			expect(payload(shot).kind).toBe('scpi');
			expect(String(payload(shot).error)).toMatchRegex(
				/screenshot is 67108864 bytes, exceeding the 4194304 byte limit/i,
			);
			expect(screenshot.scope.connected).toBe(false);

			const kept = await call(setup, 'capture_panel_setup');
			expect(payload(kept).kind).toBe('scpi');
			expect(String(payload(kept).error)).toMatchRegex(/setup is 999999999 bytes, exceeding the 16777216 byte limit/i);
			expect(setup.scope.connected).toBe(false);
		} finally {
			await setup.close();
			await screenshot.close();
		}
	});

	it('refuses to restore a setup captured from another model', async () => {
		const captured = await connect({ 'PNSU?': setupBlock, '*OPC?': '1' });
		const other = await connect({ '*OPC?': '1' }, 'SDS1204X-E');
		try {
			const { id } = payload(await call(captured, 'capture_panel_setup')).setup as { id: string };
			other.fake.sent();
			const result = await call(other, 'restore_panel_setup', { setup_id: id, confirm_restore: true });
			expect(String(payload(result).error)).toMatchRegex(/captured from SDS1104X-E, not SDS1204X-E/);
			assertSent(other.fake, []);
		} finally {
			await other.close();
			await captured.close();
		}
	});

	it('warns when the firmware moved on since the capture', async () => {
		const captured = await connect({ 'PNSU?': setupBlock, '*OPC?': '1', 'CHDR?': 'OFF' });
		try {
			const { id } = payload(await call(captured, 'capture_panel_setup')).setup as { id: string };
			captured.fake.replies.set('*IDN?', 'Siglent Technologies,SDS1104X-E,SN,7.6.1.21');
			await call(captured, 'identify');
			const result = await call(captured, 'restore_panel_setup', { setup_id: id, confirm_restore: true });
			expect(
				warnings(result).some((warning) => /firmware 7\.6\.1\.20, but the scope now reports/.test(warning)),
			).toBeTruthy();
		} finally {
			await captured.close();
		}
	});

	it('releases the setups it keeps when the server closes', async () => {
		const first = await connect({ 'PNSU?': setupBlock, '*OPC?': '1' });
		const { id } = payload(await call(first, 'capture_panel_setup')).setup as { id: string };
		await first.close();
		const second = await connect({ 'PNSU?': setupBlock, '*OPC?': '1' });
		try {
			const result = await call(second, 'restore_panel_setup', { setup_id: id, confirm_restore: true });
			expect(String(payload(result).error)).toMatchRegex(/Unknown setup/);
		} finally {
			await second.close();
		}
	});
});
