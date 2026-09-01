import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseQuantity } from '../../../scpi/values.ts';
import { applied, clamped, compare, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Guide } from '../models.ts';
import { type Scope, UnsupportedError } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { seconds, timeValue } from './schema.ts';

export const timeDivisions = [
	'1NS',
	'2NS',
	'5NS',
	'10NS',
	'20NS',
	'50NS',
	'100NS',
	'200NS',
	'500NS',
	'1US',
	'2US',
	'5US',
	'10US',
	'20US',
	'50US',
	'100US',
	'200US',
	'500US',
	'1MS',
	'2MS',
	'5MS',
	'10MS',
	'20MS',
	'50MS',
	'100MS',
	'200MS',
	'500MS',
	'1S',
	'2S',
	'5S',
	'10S',
	'20S',
	'50S',
	'100S',
] as const;

// The acquisition tools send these two next to the trigger mode, so both subsystems share one definition.
export const main = [
	param(
		'time_per_div',
		'TDIV',
		z.enum(timeDivisions),
		"Time per division, for example '1US'. The range varies by model.",
		asQuantity,
	),
	param(
		'trigger_delay',
		'TRDL',
		timeValue,
		"Trigger delay with a unit, for example '4.8US'. Negative subsecond values are sent as provided because model behavior varies.",
		asQuantity,
	),
];

const subSecond = /[MUNP]S$/i;

// p. 185 says a negative delay must be in seconds, p. 186 sets one with TRDL -4.8US. The example is followed.
export function reportDelay(scope: Scope, { trigger_delay: delay }: Values): void {
	if (typeof delay === 'string' && delay.startsWith('-') && subSecond.test(delay)) {
		scope.warn(`Negative subsecond trigger delays have model-dependent support. ${delay} was sent as provided.`);
	}
}

// Format 1 stops at 20MS and is bounded by the current time base (p. 187); Format 2 is a plain factor.
const zoomScales = timeDivisions.slice(0, timeDivisions.indexOf('20MS') + 1);
const factor = z.number().int().min(1).max(2_000_000);
// The guide gives no range for the HPOS factor. It counts zoomed time bases either side of the trigger point, so the
// magnification range of the sibling HMAG (p. 187) bounds it.
const positionFactor = z.number().min(-2_000_000).max(2_000_000);
const CLAMP_FLOOR = 1e-12;

const zoom = [
	clamped(
		'zoom_scale',
		'HMAG',
		z.union([z.enum(zoomScales), factor]),
		'Zoomed window scale. Use a time value from 1NS to the current time per division on SDS1000X-E, or a factor from 1 to 2000000 on other families.',
		asQuantity,
		CLAMP_FLOOR,
	),
	clamped(
		'zoom_position',
		'HPOS',
		z.union([seconds, positionFactor]),
		'Zoomed window position. Use a time value on SDS1000X-E or a factor of the zoomed timebase on other families. A value without a unit means seconds. The scope adjusts positions outside the main sweep.',
		asQuantity,
		CLAMP_FLOOR,
	),
];

const params = [...main, ...zoom];

const formats = { time: 'a time value', factor: 'a factor' } as const;
type Format = keyof typeof formats;

const named = (scope: Scope) => `${scope.identity?.model ?? 'The scope'} (${scope.capabilities?.family ?? 'unknown'})`;

// Keyed on the guide table the model follows, so every family models.ts knows has a format and a new one cannot be
// forgotten: the xe chapter gives HMAG/HPOS Format 1 (pp. 188, 190), the other three Format 2.
const tabulated: Record<Guide, Format> = { xe: 'time', '1000x': 'factor', '2000x': 'factor', nonSpo: 'factor' };

const formatOf = (scope: Scope): Format | undefined => {
	const guide = scope.capabilities?.guide;
	return guide && tabulated[guide];
};

const formatUsed = (value: unknown): Format => (typeof value === 'number' ? 'factor' : 'time');

function requireFormat(scope: Scope, input: Values): void {
	const expected = formatOf(scope);
	for (const { name } of zoom) {
		const value = input[name];
		if (value === undefined || formatUsed(value) === expected) continue;
		if (expected) {
			throw new UnsupportedError(
				`${named(scope)} requires ${name} as ${formats[expected]}, not ${formats[formatUsed(value)]}. Use the format supported by this model.`,
			);
		}
		scope.warn(
			`${named(scope)} has unknown zoom value support. ${name} was sent as ${formats[formatUsed(value)]} unchecked.`,
		);
	}
}

// The zoomed scale is capped at the main scale (p. 187), which is only settled once this request's own TDIV landed.
async function requireWithinMain(session: ScpiSession, scope: Scope, wanted: string): Promise<void> {
	const raw = await session.query('TDIV?');
	const scale = parseQuantity(raw)?.value;
	if (scale === undefined) {
		scope.warn(
			`The main timebase response ${JSON.stringify(raw)} could not be read. The zoom scale was sent unchecked.`,
		);
		return;
	}
	const zoomed = parseQuantity(wanted)?.value;
	if (zoomed !== undefined && zoomed > scale) {
		throw new Error(
			`zoom_scale ${wanted} exceeds the main timebase. Set time_per_div to the same or a longer interval in this request.`,
		);
	}
}

export const timebaseTools = [
	tool({
		name: 'get_timebase',
		description:
			'Read the main time per division, trigger delay, zoomed window scale, and zoomed window position. SDS1000X-E returns zoom values as times. Other families return factors. Parsed and raw values are included.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				return readback(session, params);
			}),
	}),
	tool({
		name: 'configure_timebase',
		description:
			'Configure the main time per division, trigger delay, zoomed window scale, and zoomed window position. SDS1000X-E takes zoom values as times. Other families take factors. Unknown models accept the provided format unchecked. The zoom scale cannot exceed the main time per division. The scope adjusts positions outside the main sweep.',
		input: z.object(inputs(params)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			const commands = plan(...settings(params, input));
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				requireFormat(scope, input);
				reportDelay(scope, input);
				for (const command of settings(main, input)) await session.command(command);
				if (typeof input.zoom_scale === 'string') await requireWithinMain(session, scope, input.zoom_scale);
				for (const command of settings(zoom, input)) await session.command(command);
				const state = await readback(session, applied(params, input));
				compare(scope, params, input, state, 'the zoom window is kept inside the main sweep');
				return { commands, state };
			});
		},
	}),
];
