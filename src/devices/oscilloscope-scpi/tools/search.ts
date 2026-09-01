import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import { asState, isOn } from '../../../scpi/values.ts';
import { applied, compare, flag, type Param, param, readback, settings, type Values } from '../../../tools/params.ts';
import { channels, counted as guarded } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import {
	alternating,
	bounds,
	choice,
	directed,
	gateSources,
	levelHigh as levelHighOf,
	levelLow as levelLowOf,
	level as levelOf,
	limit,
	mixed,
	polarities,
	selected,
	shape,
	timeLower,
	timeUpper,
} from './serial.ts';

const SEARCH = ':SEARch';
const MODE = ':SEARch:MODE';
const COUNT = ':SEARch:COUNt';
const EVENT = ':SEARch:EVENt';
const COPY = ':SEARch:COPY';

const copies = ['FROMtrigger', 'TOTRigger', 'CANCel'] as const;

const mixedSource = choice(
	'source',
	mixed,
	'Search source. Use an analog channel C1-C4 or a digital channel D0-D15 on mixed-signal models',
);
const analogSource = choice('source', channels, 'Search source. Use an analog channel C1-C4');
const alternatingSlope = choice(
	'slope',
	alternating,
	'Search edge. Alternate takes rising and falling edges in turn. Interval supports only Rising or Falling',
);
const directedSlope = choice('slope', directed, 'Search edge. Choose Rising or Falling');
const polarity = choice('polarity', polarities, 'pulse polarity the search takes: POSitive or NEGative');
const level = levelOf('Search');
const levelHigh = levelHighOf('Search');
const levelLow = levelLowOf('Search');

// One search mode is one row, in the order it is sent: the source first, because every level is measured against
// its scale and offset; then what the mode selects on; then the levels; then the limit range, which decides whether
// its two time bounds mean anything. The leaves are the trigger's own, under the search prefix (pp. 354-387).
const modes: Record<string, Param[]> = {
	EDGE: [mixedSource(':SEARch:EDGE:SOURce'), alternatingSlope(':SEARch:EDGE:SLOPe'), level(':SEARch:EDGE:LEVel')],
	SLOPe: [
		analogSource(':SEARch:SLOPe:SOURce'),
		alternatingSlope(':SEARch:SLOPe:SLOPe'),
		levelHigh(':SEARch:SLOPe:HLEVel'),
		levelLow(':SEARch:SLOPe:LLEVel'),
		limit(':SEARch:SLOPe:LIMit'),
		timeLower(':SEARch:SLOPe:TLOWer'),
		timeUpper(':SEARch:SLOPe:TUPPer'),
	],
	PULSE: [
		mixedSource(':SEARch:PULSe:SOURce'),
		polarity(':SEARch:PULSe:POLarity'),
		level(':SEARch:PULSe:LEVel'),
		limit(':SEARch:PULSe:LIMit'),
		timeLower(':SEARch:PULSe:TLOWer'),
		timeUpper(':SEARch:PULSe:TUPPer'),
	],
	INTerval: [
		mixedSource(':SEARch:INTerval:SOURce'),
		directedSlope(':SEARch:INTerval:SLOPe'),
		level(':SEARch:INTerval:LEVel'),
		limit(':SEARch:INTerval:LIMit'),
		timeLower(':SEARch:INTerval:TLOWer'),
		timeUpper(':SEARch:INTerval:TUPPer'),
	],
	RUNT: [
		analogSource(':SEARch:RUNT:SOURce'),
		polarity(':SEARch:RUNT:POLarity'),
		levelHigh(':SEARch:RUNT:HLEVel'),
		levelLow(':SEARch:RUNT:LLEVel'),
		limit(':SEARch:RUNT:LIMit'),
		timeLower(':SEARch:RUNT:TLOWer'),
		timeUpper(':SEARch:RUNT:TUPPer'),
	],
};

const names = Object.keys(modes) as [string, ...string[]];

const searchRow = flag('search', SEARCH, 'Whether the search function is on', isOn);
const modeRow = param(
	'mode',
	MODE,
	z.enum(names),
	'Search mode. The selected mode determines which parameters apply',
	(raw) => asState(raw, names),
);

function check(input: Values, ctx: z.RefinementCtx): void {
	const rows = modes[String(input.mode)];
	if (rows) {
		selected(rows, `search mode ${input.mode}`, input, ctx, 'mode', 'search');
		bounds(input, ctx);
	} else if (
		Object.entries(input).some(([name, value]) => value !== undefined && name !== 'search' && name !== 'mode')
	) {
		const message = 'A search parameter belongs to one search mode. Add mode to the request';
		ctx.addIssue({ code: 'custom', message, path: ['mode'] });
	}
}

export const searchTools = [
	tool({
		name: 'get_search',
		description:
			'Read whether the search function is on, which search mode is selected and the parameters of that mode. Parameters of the other modes are left unread. Use read_search_events for the events the current screen holds.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const state: Values = await readback(session, [searchRow, modeRow]);
				const rows = modes[String(state.mode)];
				if (!rows) {
					scope.warn(
						`The scope reports unsupported search mode ${JSON.stringify(state.mode)}. Only the search state and mode were read`,
					);
				}
				return { ...state, ...(rows ? await readback(session, rows) : {}) };
			}),
	}),
	tool({
		name: 'configure_search',
		description:
			'Turn the search function on or off, select a search mode, set its parameters and read back the requested values. Each parameter must be supported by the selected mode. Levels and time values adjusted by the scope are returned with a warning. Searching does not change what the scope acquires. It marks the events it finds on the waveform already captured.',
		input: z
			.strictObject({
				search: searchRow.schema.optional().describe(searchRow.description),
				mode: modeRow.schema.optional().describe(modeRow.description),
				...shape(Object.values(modes).flat()),
			})
			.superRefine(check),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const rows = modes[String(input.mode)] ?? [];
			const commands = plan(...settings([searchRow, modeRow], input), ...settings(rows, input));
			return scope.execute(async (session) => {
				gateSources(scope, input);
				for (const command of commands) await session.command(command);
				const wanted = [searchRow, modeRow, ...rows];
				const state = await readback(session, applied(wanted, input));
				compare(
					scope,
					wanted,
					input,
					state,
					'a level or a time the source and the model cannot take is moved to the nearest one they can',
				);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'read_search_events',
		description:
			'Read how many search events the current screen holds and the index of the event in its center. The search function is read first and neither count is asked for while it is off, because a search that is off marks nothing. The centered index is documented for a stopped acquisition.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				const search = isOn(await session.query(`${SEARCH}?`));
				if (!search) {
					scope.warn('The search function is off, so there is no event to count. Turn it on with configure_search');
					return { search };
				}
				return {
					search,
					events: guarded('the search event count')(await session.query(`${COUNT}?`)),
					centered_event: guarded('the centered search event')(await session.query(`${EVENT}?`)),
				};
			}),
	}),
	tool({
		name: 'copy_search_settings',
		description:
			'Copy the settings between the search and the trigger. From Trigger overwrites the search settings with the trigger ones, To Trigger overwrites the trigger settings with the search ones and Cancel undoes the last of the two. The overwritten settings are not saved anywhere and the command has no query form.',
		input: z.strictObject({
			direction: z
				.enum(copies)
				.describe(
					'From Trigger copies the trigger setup into the search, To Trigger copies the search setup into the trigger and Cancel undoes the last copy',
				),
		}),
		annotations: destructive,
		handler: ({ direction }, scope) => {
			const commands = [`${COPY} ${direction}`];
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				return { commands, write_only: [COPY] };
			});
		},
	}),
];
