import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { announcedLength, definiteLengthBlock, type FrameReader, readBinary } from '../../../scpi/codec.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import type { Scope } from '../scope.ts';
import { destructive, readOnly, tool } from './define.ts';
import { pathSegment, timeoutMs } from './schema.ts';
import { type Setup, setups } from './setups.ts';
import { waitUntilComplete } from './system.ts';

const SCREENSHOT_TIMEOUT = 20_000;
const SETUP_TIMEOUT = 15_000;
const RECOMMENDED_TIMEOUT = 10_000;
const COMPLETION_TIMEOUT = 30_000;
const KEPT_SETUPS = 8;
const KEPT_SETUP_BYTES = 16 * 1024 * 1024;
const MAX_BLOCK = 999_999_999;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

// The answer declares its own length, and that length decides how much is buffered and returned, whichever framing it
// arrives in. Refusing it at the header keeps the ceiling this tool promises instead of the connection's much larger
// one, which a 9-digit block header can drive to a gigabyte. The linefeeds after the block belong to this answer
// rather than the next one.
const bounded =
	(what: string, limit: number): FrameReader =>
	(buffer) => {
		const declared = announcedLength(buffer);
		if (declared !== undefined && declared > limit) {
			throw new ScpiError(`The ${what} is ${declared} bytes, exceeding the ${limit} byte limit.`);
		}
		const frame = readBinary(buffer);
		if (!frame) return undefined;
		let { end } = frame;
		while (buffer[end] === LF || buffer[end] === CR) end++;
		return { payload: frame.payload, end };
	};

const usbFile = z.object({
	file: pathSegment.describe('File name without extension, up to eight characters'),
	directory: z
		.array(pathSegment)
		.max(4)
		.optional()
		.describe('Directory segments, for example ["SAVE"] for /SAVE/<file>. Omit for the root directory.'),
	extension: z.enum(['xml', 'set']).optional().describe('Overrides the extension derived from the model family'),
});

type UsbFile = z.output<typeof usbFile>;

const oneLocation = {
	message: 'Choose either an internal slot or a USB file, not both.',
	path: ['slot'],
};

const exactlyOne = ({ slot, usb }: { slot?: number; usb?: UsbFile }) => (slot === undefined) !== (usb === undefined);

function extensionFor(scope: Scope): 'xml' | 'set' {
	const xe = scope.capabilities?.features.xe;
	if (xe !== 'unknown') return xe === 'supported' ? 'xml' : 'set';
	scope.warn(
		`${scope.identity?.model ?? 'The scope'} has an unknown setup-file extension. Using .set. Provide extension to choose another format.`,
	);
	return 'set';
}

// SDS1000X-E does not take '/' for the root directory (p. 151), so a file without directory segments is sent bare.
function usbPath(usb: UsbFile, scope: Scope): string {
	const name = `${usb.file}.${usb.extension ?? extensionFor(scope)}`;
	return usb.directory?.length ? `/${usb.directory.join('/')}/${name}` : name;
}

const usbCommand = (mnemonic: string, usb: UsbFile, scope: Scope): string =>
	`${mnemonic} DISK,UDSK,FILE,'${usbPath(usb, scope)}'`;

function bitmap(payload: Buffer) {
	const bytes = payload.length;
	if (bytes < 54 || payload.readUInt32LE(14) < 40) return { bytes };
	// A negative height means top-down rows, a storage detail the reported size keeps out of the public shape.
	return {
		bytes,
		width: payload.readInt32LE(18),
		height: Math.abs(payload.readInt32LE(22)),
		bits_per_pixel: payload.readUInt16LE(28),
		compression: payload.readUInt32LE(30),
	};
}

function remember(payload: Buffer, scope: Scope): Setup {
	const setup: Setup = {
		id: `setup-${randomBytes(9).toString('base64url')}`,
		format: /^\s*</.test(payload.toString('latin1', 0, 16)) ? 'xml' : 'binary',
		bytes: payload.length,
		sha256: createHash('sha256').update(payload).digest('hex'),
		captured_at: new Date().toISOString(),
		model: scope.identity?.model,
		firmware: scope.identity?.firmware,
	};
	setups.set(setup.id, { ...setup, payload });
	let bytes = [...setups.values()].reduce((total, kept) => total + kept.bytes, 0);
	for (const [id, kept] of setups) {
		if (setups.size <= KEPT_SETUPS && bytes <= KEPT_SETUP_BYTES) break;
		setups.delete(id);
		bytes -= kept.bytes;
	}
	return setup;
}

// A setup is not compatible across models, nor between firmware versions (p. 167).
function requireSameScope(setup: Setup, scope: Scope): void {
	const { model, firmware } = scope.identity ?? {};
	if (setup.model !== model) {
		throw new Error(
			`Setup ${setup.id} was captured from ${setup.model ?? 'an unidentified scope'}, not ${model ?? 'this unknown model'}. Restore it only to the same model.`,
		);
	}
	if (setup.firmware !== firmware) {
		scope.warn(
			`Setup ${setup.id} was captured on firmware ${setup.firmware ?? 'unknown'}, but the scope now reports ${firmware ?? 'unknown'}. Compatibility is not guaranteed.`,
		);
	}
}

const embed = ({ id, format }: Setup, payload: Buffer) => ({
	type: 'resource' as const,
	resource:
		format === 'xml'
			? { uri: `siglent://panel-setup/${id}`, mimeType: 'application/xml', text: payload.toString('latin1') }
			: {
					uri: `siglent://panel-setup/${id}`,
					mimeType: 'application/octet-stream',
					blob: payload.toString('base64'),
				},
});

async function settle(session: ScpiSession, scope: Scope, timeout: number | undefined) {
	const completed = await waitUntilComplete(session, timeout ?? COMPLETION_TIMEOUT);
	const identity = await scope.identify(session);
	return { completed, identity, capabilities: scope.capabilities, header: scope.header };
}

export const panelTools = [
	tool({
		name: 'capture_screenshot',
		description:
			'Capture the screen as a BMP image. The communication header must be Off. Transfers default to a 20-second timeout and are limited to 4 MiB. The image is returned as an MCP image content block, which some clients cannot display. Set include_image to false to return only image metadata.',
		input: z.object({
			include_image: z
				.boolean()
				.default(true)
				.describe('Attach the BMP as an image content block. False returns only image metadata.'),
			timeout_ms: timeoutMs.describe('Transfer timeout in milliseconds, default 20000'),
		}),
		annotations: readOnly,
		exposure: 'screenshots',
		handler: ({ include_image, timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (scope.header !== 'OFF') {
					throw new Error(
						`The communication header is ${scope.header}. Set it to Off with configure_communication_header before capturing a screenshot.`,
					);
				}
				const payload = await session.queryBinary(
					'SCDP',
					timeout_ms ?? SCREENSHOT_TIMEOUT,
					bounded('screenshot', MAX_SCREENSHOT_BYTES),
				);
				const saved = scope.screenshots?.save(payload, (reason) => scope.warn(reason));
				return {
					screenshot: { format: 'bmp', ...bitmap(payload) },
					...(saved && { saved }),
					...(include_image && {
						content: [{ type: 'image' as const, mimeType: 'image/bmp', data: payload.toString('base64') }],
					}),
				};
			}),
	}),
	tool({
		name: 'capture_panel_setup',
		description:
			'Capture the complete front-panel setup and keep it in the server under a restorable setup ID. Returns the ID, format, byte count, and SHA-256 hash. Set include_payload to true to attach the setup as a resource. Transfers larger than 16 MiB are refused. The server keeps the last eight captures, up to 16 MiB total, until the connection closes. Use save_panel_setup for persistent storage. Setup compatibility across firmware versions is not guaranteed.',
		input: z.object({
			include_payload: z
				.boolean()
				.default(false)
				.describe('Also attach the setup as an embedded resource (XML text or base64 blob)'),
			timeout_ms: timeoutMs.describe('Transfer timeout in milliseconds. Default 15000. Use at least 10000.'),
		}),
		annotations: readOnly,
		handler: ({ include_payload, timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (timeout_ms !== undefined && timeout_ms < RECOMMENDED_TIMEOUT) {
					scope.warn(`Panel setup capture may need at least 10000 ms. The requested timeout is ${timeout_ms} ms.`);
				}
				const payload = await session.queryBinary(
					'PNSU?',
					timeout_ms ?? SETUP_TIMEOUT,
					bounded('setup', KEPT_SETUP_BYTES),
				);
				if (payload.length === 0)
					throw new ScpiError('The scope returned an empty panel setup. Try capturing the setup again.');
				const setup = remember(payload, scope);
				return { setup, ...(include_payload && { content: [embed(setup, payload)] }) };
			}),
	}),
	tool({
		name: 'restore_panel_setup',
		description:
			'Restore a front-panel setup captured by this server, wait for completion, restore the communication header, and identify the scope again. Restoring replaces every scope setting. Only setup IDs from capture_panel_setup are accepted, and only for the same model. Firmware compatibility is not guaranteed. Requires `confirm_restore: true`. Nothing is sent otherwise.',
		input: z.object({
			setup_id: z
				.string()
				.regex(/^setup-[\w-]{12}$/, 'an id returned by capture_panel_setup')
				.describe('Id of a setup captured with capture_panel_setup'),
			confirm_restore: z
				.literal(true)
				.describe('Explicit acknowledgement that the current front-panel setup is discarded'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
		}),
		annotations: destructive,
		handler: async ({ setup_id, timeout_ms }, scope) => {
			const stored = setups.get(setup_id);
			if (!stored) {
				throw new Error(
					`Unknown setup ${setup_id}. Capture a new setup or use one of the last ${KEPT_SETUPS} captures kept by this server.`,
				);
			}
			if (stored.payload.length === 0 || stored.payload.length > MAX_BLOCK) {
				throw new ScpiError(
					`Setup ${setup_id} is ${stored.payload.length} bytes and is too large to restore. Capture a setup no larger than ${MAX_BLOCK} bytes.`,
				);
			}
			const { payload, ...setup } = stored;
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				requireSameScope(setup, scope);
				const block = definiteLengthBlock(payload);
				await session.command('PNSU', block);
				return {
					commands: [`PNSU ${block.toString('ascii', 0, 11)}`],
					setup,
					...(await settle(session, scope, timeout_ms)),
				};
			});
		},
	}),
	tool({
		name: 'save_panel_setup',
		description:
			'Save the current front-panel setup to internal slot 1-20 or a USB file, then wait for completion. Existing setups cannot be detected and are replaced without warning. Requires `confirm_overwrite: true`. File names support up to eight letters, digits, underscores, or hyphens. SDS1000X-E uses .xml. Other models use .set.',
		input: z
			.object({
				slot: z.int().min(1).max(20).optional().describe('Internal setup slot 1-20.'),
				usb: usbFile.optional().describe('File on the USB memory device.'),
				confirm_overwrite: z
					.literal(true)
					.describe('Explicit acknowledgement that an existing setup in that slot or file is replaced'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.refine(exactlyOne, oneLocation),
		annotations: destructive,
		handler: ({ slot, usb, timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const command = usb ? usbCommand('STPN', usb, scope) : `*SAV ${slot}`;
				await session.command(command);
				return { commands: [command], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			}),
	}),
	tool({
		name: 'recall_panel_setup',
		description:
			'Recall a front-panel setup from internal slot 0-20 or a USB file, wait for completion, restore the communication header, and identify the scope again. Slot 0 restores the default setup. Recalling replaces every scope setting. Requires `confirm_recall: true`. Nothing is sent otherwise.',
		input: z
			.object({
				slot: z.int().min(0).max(20).optional().describe('Internal setup slot 0-20. Slot 0 recalls the default setup.'),
				usb: usbFile.optional().describe('File on the USB memory device.'),
				confirm_recall: z
					.literal(true)
					.describe('Explicit acknowledgement that the current front-panel setup is discarded'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.refine(exactlyOne, oneLocation),
		annotations: destructive,
		handler: ({ slot, usb, timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const command = usb ? usbCommand('RCPN', usb, scope) : `*RCL ${slot}`;
				await session.command(command);
				return { commands: [command], ...(await settle(session, scope, timeout_ms)) };
			}),
	}),
];
