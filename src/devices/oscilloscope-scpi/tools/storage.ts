import * as z from 'zod';
import { nr3, onOff, plan } from '../../../scpi/commands.ts';
import { asQuantity, asState, isOn, quoted, unquote } from '../../../scpi/values.ts';
import {
	applied,
	clamped,
	compare,
	flag,
	inputs,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { timeoutMs } from '../../../tools/schema.ts';
import { type Channel, channels, type ScpiScope } from '../scope.ts';
import { waitUntilComplete } from './common.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const IMPORT = ':MEMory<m>:IMPort';
const REF_DATA = ':REF<r>:DATA';
const REF_SOURCE = ':REF<r>:DATA:SOURce';
const REF_RECALL = ':RECall:REFerence';
const SETUP_SAVE = ':SAVE:SETup';
const SETUP_RECALL = ':RECall:SETup';
const DEFAULT_SAVE = ':SAVE:DEFault';
const FACTORY_RECALL = ':RECall:FDEFault';
const ERASE = ':RECall:SERase';
const IMAGE = ':SAVE:IMAGe';
const COMPLETION_TIMEOUT = 30_000;

const PICOSECOND = 1e-12;
const MICROVOLT = 1e-6;
// The guide bounds none of these values: a memory or reference carries whatever unit its source did, so these keep
// a value inside what the setting can mean at all and the scope's own clamp comes back as a warning.
const seconds = z.number().min(-1e4).max(1e4);
const secondsPerDiv = z.number().min(1e-12).max(1e4);
const vertical = z.number().min(-1e12).max(1e12);
const verticalScale = z.number().min(1e-12).max(1e12);

// The guide's path shape (pp. 332, 343): a drive, directories and a file name whose extension names the format.
// The closed character set excludes quotes, commas, semicolons, spaces and dots outside the extension, so no path
// can end the quoted string it travels in, start a second command or climb out of its directory.
const segment = '[A-Za-z0-9_-]{1,64}';
export const filePath = (...extensions: string[]) =>
	z
		.string()
		.max(200)
		.regex(
			new RegExp(`^(local|net_storage|U-disk[01])(/${segment}){0,8}/${segment}\\.(${extensions.join('|')})$`),
			`A path like "local/SIGLENT/file.${extensions[0]}": the drive local, net_storage, U-disk0 or U-disk1, then directories and a file name of letters, digits, underscores or hyphens ending in .${extensions.join(' or .')}`,
		);

const numbered = (prefix: string, count: number, from = 1): string[] =>
	Array.from({ length: count }, (_, index) => `${prefix}${index + from}`);

// <x> and <m> are "# math functions" and "# memory waveforms", which the guide never puts a number to, so four of
// each is a sanity cap; <d> runs 0 to 15 and <r> is {A|B|C|D} everywhere the guide writes it.
const zooms = numbered('Z', channels.length);
const maths = numbered('F', 4);
const memories = numbered('M', 4);
const digitals = numbered('D', 16, 0);
const traces = [...channels, ...zooms, ...maths, ...memories] as [string, ...string[]];
const refSources = [...channels, ...maths, ...digitals] as [string, ...string[]];

const analog = /^[CZ](\d)$/;

// C<n> and Z<n> are gated by the model's channel count; nothing here can tell whether a math function, a memory,
// a reference or the MSO option carries a waveform, so those are sent as asked and say so.
function gateSource(scope: ScpiScope, source: string): void {
	const channel = analog.exec(source)?.[1];
	if (channel) scope.requireChannel(`C${channel}` as Channel);
	else if (/^Z?D/.test(source)) {
		scope.warn(`${source} is a digital source and requires the MSO option. Option availability is not known`);
	} else scope.warn(`Whether ${source} carries a waveform is not known. The source is used as requested`);
	if (source.startsWith('Z')) scope.warn(`${source} is a zoomed source and requires zoom to be enabled`);
}

const scaled = (name: string, mnemonic: string, schema: z.ZodType, what: string, floor: number): Param => ({
	...clamped(name, mnemonic, schema, what, asQuantity, floor),
	wire: nr3,
});

const labelText = (mnemonic: string): Param => ({
	...param(
		'label_text',
		mnemonic,
		z
			.string()
			.max(20)
			.regex(/^[A-Z0-9 _+.-]*$/, 'up to 20 of A-Z, 0-9, space, underscore, plus, dot or hyphen'),
		'label text, up to 20 characters',
		unquote,
	),
	wire: quoted,
});

const at = (rows: readonly Param[], token: string, value: string): Param[] =>
	rows.map((row) => ({ ...row, mnemonic: row.mnemonic.replace(token, value) }));

const memoryEnabled = flag('enabled', ':MEMory<m>:SWITch', 'the display of the memory waveform', isOn);

const memoryRows: Param[] = [
	scaled(
		'horizontal_position',
		':MEMory<m>:HORizontal:POSition',
		seconds,
		'horizontal position of the memory waveform in seconds, like a trigger delay',
		PICOSECOND,
	),
	scaled(
		'horizontal_scale',
		':MEMory<m>:HORizontal:SCALe',
		secondsPerDiv,
		'horizontal scale of the memory waveform in seconds per division',
		PICOSECOND,
	),
	flag(
		'horizontal_sync',
		':MEMory<m>:HORizontal:SYNC',
		'following the horizontal parameters of the imported source',
		isOn,
	),
	flag('label', ':MEMory<m>:LABel', 'the label on screen', isOn),
	labelText(':MEMory<m>:LABel:TEXT'),
	memoryEnabled,
	scaled(
		'vertical_position',
		':MEMory<m>:VERTical:POSition',
		vertical,
		'vertical position of the memory waveform in its own unit',
		MICROVOLT,
	),
	scaled(
		'vertical_scale',
		':MEMory<m>:VERTical:SCALe',
		verticalScale,
		'vertical scale per division of the memory waveform in its own unit',
		MICROVOLT,
	),
];

const memorySettings = memoryRows.filter((row) => row !== memoryEnabled);

const memIndex = z
	.int()
	.min(1)
	.max(4)
	.default(1)
	.describe('Memory waveform, 1 for M1 to 4 for M4. Model-specific limits are unknown, so four is the validation cap');

const locations = ['REFA', 'REFB', 'REFC', 'REFD'] as const;
const locationInput = z.enum(locations).default('REFA').describe('Reference waveform REFA to REFD');
const letter = (location: string): string => location.slice(3);

const refLabel: Param[] = [
	flag('label', ':REF<r>:LABel', 'the label on screen', isOn),
	labelText(':REF<r>:LABel:TEXT'),
];
const refVertical: Param[] = [
	scaled(
		'vertical_scale',
		':REF<r>:DATA:SCALe',
		verticalScale,
		'Vertical scale per division of the reference in its own unit. Available only while the reference is saved and displayed',
		MICROVOLT,
	),
	scaled(
		'vertical_position',
		':REF<r>:DATA:POSition',
		vertical,
		'Vertical offset of the reference in its own unit. Available only while the reference is saved and displayed',
		MICROVOLT,
	),
];
const refRows = [...refLabel, ...refVertical];

const saveFormats = {
	BINary: { mnemonic: ':SAVE:BINary', extension: 'bin', sources: [...traces, 'D0_D15', 'ZD0_ZD15'] },
	CSV: { mnemonic: ':SAVE:CSV', extension: 'csv', sources: [...traces, 'D0_D15', 'DIGital', 'ZD0_ZD15', 'ZDIGital'] },
	MATLab: {
		mnemonic: ':SAVE:MATLab',
		extension: 'mat',
		sources: [...traces, 'D0_D15', 'DIGital', 'ZD0_ZD15', 'ZDIGital'],
	},
	REFerence: { mnemonic: ':SAVE:REFerence', extension: 'ref', sources: refSources },
} as const;
const saveSources = [...new Set(Object.values(saveFormats).flatMap(({ sources }) => sources))] as [string, ...string[]];

const imageTypes: Record<string, string> = { bmp: 'BMP', jpg: 'JPG', png: 'PNG' };

const chosen = (...values: unknown[]): number => values.filter((value) => value !== undefined).length;

export const storageTools = [
	tool({
		name: 'get_memory',
		description:
			'Read one memory waveform M1-M4: display switch, horizontal position, scale and sync, label, label text, vertical position and scale. On SDS1204X HD firmware 6.9.13.1.1.6.7 no memory query answers while the memory holds no waveform, including the display switch, so this tool refuses unless loaded: true asserts that a waveform was imported into this memory. The import command has no query form and the memory contents cannot be read back.',
		input: z.strictObject({
			memory: memIndex,
			loaded: z
				.literal(true)
				.describe('Assertion that this memory holds an imported waveform. No memory query answers otherwise'),
		}),
		annotations: readOnly,
		handler: ({ memory }, scope) =>
			scope.execute(async (session) => {
				const index = String(memory);
				const state = await readback(session, at([memoryEnabled, ...memorySettings], '<m>', index));
				return { memory, ...state, write_only: [IMPORT] };
			}),
	}),
	tool({
		name: 'configure_memory',
		description:
			'Set the display, position, scale, sync and label of one memory waveform M1-M4. On SDS1204X HD firmware 6.9.13.1.1.6.7 no memory query answers while the memory holds no waveform, so settings are read back only when loaded: true asserts that a waveform was imported into this memory, and are otherwise write only with a warning. Use import_memory to load a waveform into the memory. Values adjusted by the scope are returned with a warning.',
		input: z
			.strictObject({
				memory: memIndex,
				loaded: z
					.literal(true)
					.optional()
					.describe('Assertion that this memory holds an imported waveform, enabling read-back'),
				...inputs(memoryRows),
			})
			.refine((input: Values) => memoryRows.some(({ name }) => input[name] !== undefined), {
				message: 'No parameters given, nothing to configure',
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const index = String(input.memory);
			const rows = at(memoryRows, '<m>', index);
			const commands = plan(...settings(rows, input));
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state: Record<string, unknown> = {};
				if (input.loaded === true) {
					Object.assign(state, await readback(session, at(applied(memoryRows, input), '<m>', index)));
					compare(scope, rows, input, state, 'the scope clamps a value to what the imported waveform can take');
				} else {
					scope.warn(
						'Nothing was read back. No memory query answers while the memory holds no waveform, pass loaded: true after an import to enable read-back',
					);
				}
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'import_memory',
		description:
			'Import a waveform into one memory M1-M4 from an analog channel C1-C4, a zoomed trace Z1-Z4, a math function F1-F4, another memory or a .bin waveform file on scope storage, then wait for completion. The import replaces the memory contents, which cannot be read back or restored. The scope provides no file listing, so a named file cannot be checked first. Requires confirm_overwrite_memory: true. Nothing is sent otherwise.',
		input: z
			.strictObject({
				memory: memIndex,
				source: z.enum(traces).optional().describe('waveform to import: C1-C4, Z1-Z4, F1-F4 or M1-M4'),
				file: filePath('bin').optional().describe('waveform file on scope storage, for example local/SIGLENT/test.bin'),
				confirm_overwrite_memory: z
					.literal(true)
					.describe('Explicit acknowledgement that the memory waveform is replaced'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.refine(({ source, file }) => (source === undefined) !== (file === undefined), {
				message: 'Import either a trace or a file, not both',
				path: ['source'],
			}),
		annotations: destructive,
		handler: ({ memory, source, file, timeout_ms }, scope) => {
			const command = `${IMPORT.replace('<m>', String(memory))} ${source ?? quoted(file)}`;
			return scope.execute(async (session) => {
				if (source !== undefined) gateSource(scope, source);
				await session.command(command);
				return {
					commands: [command],
					completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT),
					write_only: [IMPORT],
				};
			});
		},
	}),
	tool({
		name: 'get_reference',
		description:
			'Read one reference waveform REFA-REFD: label, label text, source, vertical scale and vertical position. The display state has no query form and cannot be read.',
		input: z.strictObject({ location: locationInput }),
		annotations: readOnly,
		handler: ({ location }, scope) =>
			scope.execute(async (session) => ({
				location,
				...(await readback(session, at(refLabel, '<r>', letter(location)))),
				source: asState(await session.query(`${REF_SOURCE.replace('<r>', letter(location))}?`), refSources),
				...(await readback(session, at(refVertical, '<r>', letter(location)))),
				write_only: [REF_DATA],
			})),
	}),
	tool({
		name: 'configure_reference',
		description:
			'Configure one reference waveform REFA-REFD: save a waveform into it, recall a .ref file from scope storage into it, call it up or take it off screen, and set its label and vertical scale and position. Saving or recalling replaces the stored reference, which cannot be restored, and requires confirm_overwrite_reference: true. Scale and position are accepted only while the reference is saved and displayed, and that state cannot be checked first.',
		input: z
			.strictObject({
				location: locationInput,
				save_source: z
					.enum(refSources)
					.optional()
					.describe(
						'Save this waveform into the reference: an analog channel C1-C4, a math function F1-F4 or a digital line D0-D15. Requires confirm_overwrite_reference',
					),
				recall_file: filePath('ref')
					.optional()
					.describe(
						'Recall this .ref file from scope storage into the reference. Requires confirm_overwrite_reference',
					),
				display: z.boolean().optional().describe('true calls the reference up on screen, false takes it off'),
				...inputs(refRows),
				confirm_overwrite_reference: z
					.literal(true)
					.optional()
					.describe('Explicit acknowledgement that the waveform stored in the reference is replaced'),
			})
			.superRefine((input: Values, ctx) => {
				if (input.save_source !== undefined && input.recall_file !== undefined) {
					ctx.addIssue({ code: 'custom', message: 'Save a trace or recall a file, not both', path: ['recall_file'] });
				}
				if (
					(input.save_source !== undefined || input.recall_file !== undefined) &&
					input.confirm_overwrite_reference !== true
				) {
					ctx.addIssue({
						code: 'custom',
						message:
							'Saving or recalling replaces the waveform stored in the reference. Set confirm_overwrite_reference to true',
						path: ['confirm_overwrite_reference'],
					});
				}
				if (input.display === false && (input.vertical_scale !== undefined || input.vertical_position !== undefined)) {
					ctx.addIssue({
						code: 'custom',
						message: 'The scale and position apply only while the reference is displayed. Set display to true',
						path: ['display'],
					});
				}
				if (
					input.save_source === undefined &&
					input.recall_file === undefined &&
					input.display === undefined &&
					!refRows.some(({ name }) => input[name] !== undefined)
				) {
					ctx.addIssue({ code: 'custom', message: 'No parameters given, nothing to configure' });
				}
			}),
		annotations: destructive,
		handler: (input: Values, scope) => {
			const r = letter(input.location as string);
			const rows = at(refRows, '<r>', r);
			const data = REF_DATA.replace('<r>', r);
			const commands = plan(
				input.recall_file !== undefined && `${REF_RECALL} ${input.location},${quoted(input.recall_file)}`,
				input.save_source !== undefined && `${data} SAVE,${input.save_source}`,
				input.display !== undefined && `${data} ${input.display ? 'LOAD' : 'UNLoad'}`,
				...settings(rows, input),
			);
			return scope.execute(async (session) => {
				if (typeof input.save_source === 'string') gateSource(scope, input.save_source);
				if ((input.vertical_scale !== undefined || input.vertical_position !== undefined) && input.display !== true) {
					scope.warn(
						'Scale and position are accepted only while the reference is saved and displayed, and that state cannot be checked first',
					);
				}
				for (const command of commands) await session.command(command);
				const state: Values = await readback(session, applied(rows, input));
				if (input.save_source !== undefined || input.recall_file !== undefined) {
					state.source = asState(await session.query(`${REF_SOURCE.replace('<r>', r)}?`), refSources);
				}
				compare(scope, rows, input, state, 'the reference must be saved and displayed for the value to take');
				if (typeof input.save_source === 'string' && state.source !== input.save_source) {
					scope.warn(
						`save_source was set to ${JSON.stringify(input.save_source)} but the scope reports ${JSON.stringify(state.source)}`,
					);
				}
				return { commands, state, write_only: [REF_DATA] };
			});
		},
	}),
	tool({
		name: 'save_panel_setup',
		description:
			'Save the current setup to internal slot 1-10, to an .xml file on scope storage, or as the default setup the Default key restores, then wait for completion. An existing setup in that slot or file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise.',
		input: z
			.strictObject({
				slot: z.int().min(1).max(10).optional().describe('Internal setup slot 1 to 10, stored as SDS000x.xml'),
				file: filePath('xml').optional().describe('Setup file on scope storage, for example local/SIGLENT/default.xml'),
				default_setup: z
					.enum(['CUSTom', 'FACTory'])
					.optional()
					.describe('Save the current settings (CUSTom) or the factory settings (FACTory) as the default setup'),
				confirm_overwrite: z
					.literal(true)
					.describe('Explicit acknowledgement that an existing setup in that slot or file is replaced'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.refine(({ slot, file, default_setup }) => chosen(slot, file, default_setup) === 1, {
				message: 'Choose one destination: slot, file or default_setup',
				path: ['slot'],
			}),
		annotations: destructive,
		handler: ({ slot, file, default_setup, timeout_ms }, scope) => {
			const command =
				default_setup !== undefined
					? `${DEFAULT_SAVE} ${default_setup}`
					: slot !== undefined
						? `${SETUP_SAVE} INTernal,${slot}`
						: `${SETUP_SAVE} EXTernal,${quoted(file)}`;
			return scope.execute(async (session) => {
				await session.command(command);
				return { commands: [command], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			});
		},
	}),
	tool({
		name: 'recall_panel_setup',
		description:
			'Recall a setup from internal slot 1-10, from an .xml file on scope storage, or the factory settings, then wait for completion. Recalling replaces every scope setting. The scope provides no setup listing, so a named slot or file cannot be checked first. Requires confirm_recall: true. Nothing is sent otherwise.',
		input: z
			.strictObject({
				slot: z.int().min(1).max(10).optional().describe('Internal setup slot 1 to 10'),
				file: filePath('xml').optional().describe('Setup file on scope storage, for example local/SIGLENT/default.xml'),
				factory: z.literal(true).optional().describe('Recall the factory settings'),
				confirm_recall: z
					.literal(true)
					.describe('Explicit acknowledgement that the current scope settings are discarded'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.refine(({ slot, file, factory }) => chosen(slot, file, factory) === 1, {
				message: 'Choose one origin: slot, file or factory',
				path: ['slot'],
			}),
		annotations: destructive,
		handler: ({ slot, file, factory, timeout_ms }, scope) => {
			const command = factory
				? FACTORY_RECALL
				: slot !== undefined
					? `${SETUP_RECALL} INTernal,${slot}`
					: `${SETUP_RECALL} EXTernal,${quoted(file)}`;
			return scope.execute(async (session) => {
				await session.command(command);
				return { commands: [command], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			});
		},
	}),
	tool({
		name: 'erase_internal_storage',
		description:
			'Delete every user defined file stored inside the scope: reference waveforms, internal setups, internal mask files, custom default setups and waveform files copied to the AWG, then wait for completion. Files on USB or network storage are kept. This cannot be undone. Requires confirm_erase: true. Nothing is sent otherwise.',
		input: z.strictObject({
			confirm_erase: z
				.literal(true)
				.describe('Explicit acknowledgement that every user defined file inside the scope is deleted'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
		}),
		annotations: destructive,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				await session.command(ERASE);
				return { commands: [ERASE], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			}),
	}),
	tool({
		name: 'save_waveform_file',
		description:
			'Save waveform data to a file on scope storage and wait for completion. BINary writes .bin, CSV writes .csv with optional instrument parameters, MATLab writes .mat and REFerence writes a .ref reference waveform. The path extension must match the format. An existing file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise.',
		input: z
			.strictObject({
				format: z.enum(['BINary', 'CSV', 'MATLab', 'REFerence']).describe('file format written'),
				path: filePath('bin', 'csv', 'mat', 'ref').describe(
					'destination on scope storage, for example U-disk0/SIGLENT/c1.bin',
				),
				source: z
					.enum(saveSources)
					.describe(
						'Waveform to save. BINary takes C1-C4, Z1-Z4, F1-F4, M1-M4 and the per-bit digital groups D0_D15 and ZD0_ZD15. CSV and MATLab add the by-bus groups DIGital and ZDIGital. REFerence takes C1-C4, F1-F4 or a digital line D0-D15',
					),
				include_parameters: z
					.boolean()
					.optional()
					.describe('Also write the instrument configuration into the file. CSV format only, default off'),
				confirm_overwrite: z.literal(true).describe('Explicit acknowledgement that an existing file is replaced'),
				timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
			})
			.superRefine(({ format, path, source, include_parameters }, ctx) => {
				const { extension, sources } = saveFormats[format];
				if (!path.endsWith(`.${extension}`)) {
					ctx.addIssue({
						code: 'custom',
						message: `The ${format} format writes .${extension} files. Name the path accordingly`,
						path: ['path'],
					});
				}
				if (!(sources as readonly string[]).includes(source)) {
					ctx.addIssue({
						code: 'custom',
						message: `${source} is not a documented source of the ${format} format`,
						path: ['source'],
					});
				}
				if (include_parameters !== undefined && format !== 'CSV') {
					ctx.addIssue({
						code: 'custom',
						message: 'include_parameters applies to the CSV format',
						path: ['include_parameters'],
					});
				}
			}),
		annotations: destructive,
		handler: ({ format, path, source, include_parameters, timeout_ms }, scope) => {
			const suffix = format === 'CSV' ? `,${onOff(include_parameters ?? false)}` : '';
			const command = `${saveFormats[format].mnemonic} ${quoted(path)},${source}${suffix}`;
			return scope.execute(async (session) => {
				gateSource(scope, source);
				await session.command(command);
				return { commands: [command], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			});
		},
	}),
	tool({
		name: 'save_screenshot',
		description:
			'Save a screenshot to a .bmp, .jpg or .png file on scope storage and wait for completion. The image format follows the file extension. An existing file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise. Use capture_screenshot to transfer the image to the client instead.',
		input: z.strictObject({
			path: filePath('bmp', 'jpg', 'png').describe(
				'destination on scope storage, for example U-disk0/SIGLENT/screen.png',
			),
			inverted: z
				.boolean()
				.default(false)
				.describe('Store the image with inverted colors, a white background instead of a black one'),
			confirm_overwrite: z.literal(true).describe('Explicit acknowledgement that an existing file is replaced'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
		}),
		annotations: destructive,
		handler: ({ path, inverted, timeout_ms }, scope) => {
			const type = imageTypes[path.slice(path.lastIndexOf('.') + 1)];
			const command = `${IMAGE} ${quoted(path)},${type},${onOff(inverted)}`;
			return scope.execute(async (session) => {
				await session.command(command);
				return { commands: [command], completed: await waitUntilComplete(session, timeout_ms ?? COMPLETION_TIMEOUT) };
			});
		},
	}),
];
