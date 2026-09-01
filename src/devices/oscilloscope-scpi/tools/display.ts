import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { asState, isOn, parseState } from '../../../scpi/values.ts';
import {
	applied,
	compare,
	flag,
	inputs,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { counted, type ScpiScope } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const CLEAR = ':DISPlay:CLEar';
const TRANSPARENCE = ':DISPlay:TRANsparence';

const axisModes = ['FIXed', 'MOVing'] as const;
const grids = ['FULL', 'LIGHt', 'NONE'] as const;
const menuStyles = ['EMBedded', 'FLOating'] as const;
const hideTimes = ['OFF', '3S', '5S', '10S', '30S', '60S'] as const;
// The union of the per-model sets of p. 218: the sub-second values belong to the larger series, so the scope decides
// and a value it did not take comes back as a warning.
const persistences = ['OFF', 'INFinite', '100MS', '200MS', '500MS', '1S', '5S', '10S', '30S'] as const;
const types = ['VECTor', 'DOT'] as const;

const level = (name: string, mnemonic: string, what: string): Param =>
	param(name, mnemonic, z.number().int().min(0).max(100), what, counted(name));

const joined = (raw: string): boolean | { raw: string } => {
	const type = parseState(raw, types);
	return type === undefined ? { raw } : type === 'VECTor';
};

const before: Param[] = [
	flag('axis_labels', ':DISPlay:AXIS', 'the axis labels on the grid', isOn),
	param(
		'axis_mode',
		':DISPlay:AXIS:MODE',
		z.enum(axisModes),
		'Fixed keeps the axes in place while their coordinates follow the waveform. Moving lets the axes move with it',
		(raw) => asState(raw, axisModes),
	),
	level('backlight', ':DISPlay:BACKlight', 'screen backlight in percent, 0 to 100'),
	flag('color_grade', ':DISPlay:COLor', 'color grading, which colors the trace by how often a point is hit', isOn),
	level('grid_intensity', ':DISPlay:GRATicule', 'grid brightness in percent, 0 to 100'),
	param('grid', ':DISPlay:GRIDstyle', z.enum(grids), 'grid style', (raw) => asState(raw, grids)),
	level('trace_intensity', ':DISPlay:INTensity', 'waveform brightness in percent, 0 to 100'),
	param(
		'menu_style',
		':DISPlay:MENU',
		z.enum(menuStyles),
		'menu style, embedded beside the grid or floating over it',
		(raw) => asState(raw, menuStyles),
	),
	param('menu_hide', ':DISPlay:MENU:HIDE', z.enum(hideTimes), 'time after which the menu hides itself', (raw) =>
		asState(raw, hideTimes),
	),
	param(
		'persistence',
		':DISPlay:PERSistence',
		z.enum(persistences),
		'Persistence duration. The sub-second values are available on the larger series only',
		(raw) => asState(raw, persistences),
	),
];

const transparence = level(
	'transparence',
	TRANSPARENCE,
	'Transparency of the information bar in percent, 0 to 100. SHS800X/SHS1000X handhelds only',
);

const joinPoints: Param = {
	...flag(
		'join_points',
		':DISPlay:TYPE',
		'Draw interpolation lines between sample points. Disable to show dots',
		joined,
	),
	wire: (value) => (value ? 'VECTor' : 'DOT'),
};

const params = [...before, transparence, joinPoints];

const handheld = (scope: ScpiScope): boolean => /^SHS/i.test(scope.identity?.model ?? '');

// p. 219 documents the transparence for the SHS800X/SHS1000X and no other model, so another model is refused rather
// than asked: an undocumented query blocks for the whole timeout and takes the connection with it.
function requireTransparence(scope: ScpiScope): void {
	if (!handheld(scope)) {
		throw new UnsupportedError(
			`The information-bar transparence is available on SHS800X/SHS1000X handhelds, not ${scope.identity?.model}`,
		);
	}
}

export const displayTools = [
	tool({
		name: 'get_display',
		description:
			'Read the display configuration, including axis labels, backlight, color grading, grid style and intensity, trace intensity, menu style, persistence and interpolation. Transparence is included on SHS800X/SHS1000X handhelds only.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => readback(session, handheld(scope) ? params : [...before, joinPoints])),
	}),
	tool({
		name: 'configure_display',
		description:
			'Set the display configuration and read back the requested values. Sub-second persistence is available on the larger series only and transparence on SHS800X/SHS1000X handhelds only. Values the scope did not take are returned with a warning.',
		input: z.strictObject(inputs(params)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				if (input.transparence !== undefined) requireTransparence(scope);
				for (const command of commands) await session.command(command);
				const state = await readback(session, applied(params, input));
				compare(scope, params, input, state);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'clear_display',
		description:
			'Clear the waveform displayed on the screen. Accumulated persistence and color grading are discarded and cannot be restored. The command has no query form.',
		annotations: destructive,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command(CLEAR);
				return { commands: [CLEAR] };
			}),
	}),
];
