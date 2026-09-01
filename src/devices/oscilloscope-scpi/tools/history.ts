import * as z from 'zod';
import { nr3, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { asQuantity, asState, isOn, parseFields, parseState } from '../../../scpi/values.ts';
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
import { counted, type ScpiScope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';

const HISTORY = ':HISTORy';
const LIST = ':HISTORy:LIST';
const TIME = ':HISTORy:TIME';

const states = ['ON', 'OFF'] as const;
const listTypes = ['TIME', 'DELTa'] as const;
const plays = ['BACKWards', 'PAUSe', 'FORWards'] as const;

const enabled = flag(
	'enabled',
	HISTORY,
	'History mode on or off. A frame, the list and playback require it to be on',
	isOn,
);
// The guide describes the query as "the current number of history frames" while its own example reads back the frame
// it just selected (p. 273), so the answer is treated as the current frame.
const frame = param(
	'frame',
	':HISTORy:FRAMe',
	z.number().int().min(1),
	'Frame to show, 1 to the newest frame the scope holds. Memory depth bounds how many frames exist',
	counted('frame'),
);
const interval: Param = {
	...clamped(
		'interval',
		':HISTORy:INTERval',
		z.number().min(1e-6).max(1),
		'seconds a frame stays on screen during playback, 1 us to 1 s',
		asQuantity,
		1e-6,
	),
	wire: nr3,
};
const play = param(
	'play',
	':HISTORy:PLAY',
	z.enum(plays),
	'Playback of the recorded frames. Forwards plays first-to-last, backwards last-to-first',
	(raw) => asState(raw, plays),
);

// The list carries its own positional type (OFF|ON[,TIME|DELTa]), so its line is built and decoded by hand; these
// rows exist for the input schema and the read-back comparison only, which is why they have no parser.
const listRows: Param[] = [
	param('list', LIST, z.boolean(), 'the history list beside the waveform'),
	param(
		'list_type',
		LIST,
		z.enum(listTypes),
		'Time column of the list: the sampling time or the interval between frames. Requires list',
	),
];

const all = [enabled, frame, interval, ...listRows, play];

const listCommand = ({ list, list_type }: Values): string | undefined =>
	list === undefined ? undefined : `${LIST} ${list ? `ON${list_type === undefined ? '' : `,${list_type}`}` : 'OFF'}`;

function decodeList(raw: string): Values {
	const [state = '', type] = parseFields(raw);
	const on = parseState(state, states);
	return {
		list: on === undefined ? { raw } : on === 'ON',
		...(type !== undefined && { list_type: asState(type, listTypes) }),
		list_raw: raw,
	};
}

const clock = /^(\d+):(\d+):(\d+)\.(\d+)$/;

function timestamp(scope: ScpiScope, raw: string) {
	const [, hour, minute, second, microsecond] = clock.exec(raw.trim()) ?? [];
	if (hour === undefined) {
		scope.warn(
			`The frame timestamp ${JSON.stringify(raw.trim())} was not recognized as hours:minutes:seconds.microseconds`,
		);
		return { raw };
	}
	return { hour: Number(hour), minute: Number(minute), second: Number(second), microsecond: Number(microsecond), raw };
}

async function requireHistoryOn(session: ScpiSession, scope: ScpiScope): Promise<void> {
	const raw = await session.query(`${HISTORY}?`);
	const on = parseState(raw, states);
	if (on === 'OFF') {
		throw new UnsupportedError(
			'History mode is off. Set enabled to true in the same request before selecting a frame, showing the list or playing',
		);
	}
	if (on === undefined) {
		scope.warn(
			`The history mode response ${JSON.stringify(raw)} was not recognized. The gated settings were sent unchecked`,
		);
	}
}

export const historyTools = [
	tool({
		name: 'get_history',
		description:
			'Read history mode, the current frame, the playback interval, the history list, the playback state and the acquire timestamp of the current frame. When history mode is off, only the mode is read, because frames exist only while it is on.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state = await readback(session, [enabled]);
				if (state.enabled !== true) {
					scope.warn('History mode is not on. The frame, interval, list, playback and timestamp were not read');
					return state;
				}
				return {
					...state,
					...(await readback(session, [frame, interval])),
					...decodeList(await session.query(`${LIST}?`)),
					...(await readback(session, [play])),
					timestamp: timestamp(scope, await session.query(`${TIME}?`)),
				};
			}),
	}),
	tool({
		name: 'configure_history',
		description:
			'Turn history mode on or off, select a frame, set the playback interval, show or hide the history list and control playback, then read back the requested values. Selecting a frame, showing the list or playing requires history mode. The scope clamps a frame it does not hold, which is returned with a warning.',
		input: z
			.strictObject(inputs(all))
			.refine(
				({ enabled: on, frame: selected, list, play: playing }: Values) =>
					on !== false || (selected === undefined && list === undefined && playing === undefined),
				{
					message:
						'Frame selection, the history list and playback require history mode. Do not disable it in the same request',
					path: ['enabled'],
				},
			)
			.refine(({ list, list_type }: Values) => list_type === undefined || list === true, {
				message: 'list_type requires list. Remove it or show the list',
				path: ['list_type'],
			}),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(
				...settings([enabled, frame, interval], input),
				listCommand(input),
				...settings([play], input),
			);
			return scope.execute(async (session) => {
				const gated = input.frame !== undefined || input.play !== undefined || input.list === true;
				if (gated && input.enabled === undefined) await requireHistoryOn(session, scope);
				for (const command of commands) await session.command(command);
				const state: Values = {
					...(await readback(session, applied([enabled, frame, interval], input))),
					...(input.list === undefined ? {} : decodeList(await session.query(`${LIST}?`))),
					...(await readback(session, applied([play], input))),
				};
				compare(scope, all, input, state, 'the frames it holds depend on the acquisitions in memory');
				return { commands, state };
			});
		},
	}),
];
