import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, asState, parseQuantity, parseState } from '../../../scpi/values.ts';
import {
	applied,
	clamped,
	compare,
	flag,
	inputs,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { channels, type Scope } from '../scope.ts';
import { destructive, readOnly, tool } from './define.ts';
import { volts } from './schema.ts';

const locations = ['REFA', 'REFB', 'REFC', 'REFD'] as const;
const sources = [...channels, 'MATH'] as const;
const states = ['ON', 'OFF'] as const;

const state = (raw: string) => asState(raw, states);
const MIN_SCALE = 500e-6;
const MAX_SCALE = 10;
const CLAMP_FLOOR = 1e-6;

const inScale = (value: string): boolean => {
	const scale = parseQuantity(value)?.value;
	return scale !== undefined && scale >= MIN_SCALE && scale <= MAX_SCALE;
};

const selection = [
	param('location', 'REFLA', z.enum(locations), 'reference channel every other reference command acts on', (raw) =>
		asState(raw, locations),
	),
	param('source', 'REFSR', z.enum(sources), 'waveform the reference channel is saved from', (raw) =>
		asState(raw, sources),
	),
];

const output = [
	flag('display', 'REFDS', 'Show the selected reference channel. The channel must contain a saved waveform.', state),
	clamped(
		'vertical_scale',
		'REFSC',
		volts.refine(inScale, 'Vertical scale must be between 500uV and 10V.'),
		'Vertical scale per division from 500uV to 10V. The reference must be saved and displayed.',
		asQuantity,
		CLAMP_FLOOR,
	),
	clamped(
		'vertical_position',
		'REFPO',
		volts,
		'Vertical offset. The allowed range follows the scale. The scope clamps to the nearest allowed value.',
		asQuantity,
		CLAMP_FLOOR,
	),
];

const params = [...selection, ...output];
const writeOnly = ['REFCL', 'REFSA'];

interface ReferenceInput extends Values {
	location?: (typeof locations)[number];
	source?: (typeof sources)[number];
	display?: boolean;
	vertical_scale?: string;
	vertical_position?: string;
	save?: boolean;
}

const scaled = (input: ReferenceInput): boolean =>
	input.vertical_scale !== undefined || input.vertical_position !== undefined;

// REFDS needs a stored waveform, REFSC and REFPO need one that is displayed too (pp. 155, 158, 161). REFSA has no
// query form, so a save in the same request is the only proof of storage; otherwise REFDS? is the closest evidence,
// because the guide allows the display only for a stored reference.
async function guard(session: ScpiSession, scope: Scope, input: ReferenceInput): Promise<void> {
	if (input.save === true || (input.display === undefined && !scaled(input))) return;
	const raw = await session.query('REFDS?');
	const displayed = parseState(raw, states);
	if (displayed === 'ON') return;
	if (displayed === undefined) {
		scope.warn(
			`The reference display response ${JSON.stringify(raw)} was not recognized. The settings were sent unchecked.`,
		);
		return;
	}
	if (scaled(input) && input.display !== true) {
		throw new Error(
			'The selected reference is not displayed. Set `display: true` or `save: true` in the same request.',
		);
	}
	scope.warn(
		'The save command has no query form. The tool cannot confirm that the selected reference contains a saved waveform.',
	);
}

// PG01-E02C lists all seven REFERENCE commands as SDS1000X-E only (pp. 154-163), so scope.require('xe') gates them.

export const referenceTools = [
	tool({
		name: 'get_reference',
		description:
			'Read the selected reference channel, its source, visibility, vertical scale, and vertical offset. Closing and saving a reference have no query form and cannot be read back. SDS1000X-E only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				return { ...(await readback(session, params)), write_only: writeOnly };
			}),
	}),
	tool({
		name: 'configure_reference',
		description:
			'Select and configure a reference channel. Sources are channels C1-C4 or Math. Saving stores the visible waveform range and replaces the selected reference. Saving requires a location and `confirm_overwrite_reference: true`. Display and vertical settings require a saved reference. The vertical scale is 500uV to 10V. The scope may clamp the vertical offset. SDS1000X-E only.',
		input: z
			.object({
				...inputs(params),
				save: z
					.boolean()
					.optional()
					.describe('Store the source waveform in the selected reference channel and display it.'),
				confirm_overwrite_reference: z
					.literal(true)
					.optional()
					.describe('Explicit acknowledgement that the waveform stored in the selected reference channel is replaced'),
			})
			.refine(({ save, location }: ReferenceInput) => !save || location !== undefined, {
				message: 'Saving replaces a reference waveform. Choose the location to replace.',
				path: ['location'],
			})
			.refine(({ save, confirm_overwrite_reference }) => !save || confirm_overwrite_reference === true, {
				message:
					'Saving replaces the waveform stored in the reference channel. Set confirm_overwrite_reference to true.',
				path: ['confirm_overwrite_reference'],
			}),
		annotations: destructive,
		handler: (input: ReferenceInput, scope) => {
			const selecting = settings(selection, input);
			const commands = plan(...selecting, input.save === true && 'REFSA', ...settings(output, input));
			const rest = commands.slice(selecting.length);
			return scope.execute(async (session) => {
				scope.require('xe');
				if (input.source && input.source !== 'MATH') scope.requireChannel(input.source);
				for (const command of selecting) await session.command(command);
				await guard(session, scope, input);
				for (const command of rest) await session.command(command);
				const state = await readback(session, applied(params, input as Values));
				compare(scope, params, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'close_reference',
		description:
			'Close the Reference function. The command has no query form. Its effect on stored waveforms is unknown. SDS1000X-E only.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.require('xe');
				await session.command('REFCL');
				return { commands: ['REFCL'] };
			}),
	}),
];
