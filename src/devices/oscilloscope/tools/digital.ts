import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseFields, parseQuantity, parseState } from '../../../scpi/values.ts';
import type { Feature, Support } from '../models.ts';
import { type Scope, UnsupportedError } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { digital, digitals, thresholdVolts } from './schema.ts';

type Variant = 'xe' | 'plus';
type Group = 'd0_d7' | 'd8_d15';

const groups = ['d0_d7', 'd8_d15'] as const;
const states = ['OFF', 'ON'] as const;
const presets = ['TTL', 'CMOS', 'CMOS3.3', 'CMOS2.5', 'LVCMOS33', 'LVCMOS25', 'CUSTOM'] as const;

type Preset = (typeof presets)[number];

interface Definition {
	models: string;
	feature: Feature;
	state: string;
	trace: string;
	groups: Record<Group, string>;
	presets: readonly Preset[];
}

const variants: Record<Variant, Definition> = {
	plus: {
		models: 'SDS2000X/SDS1000X',
		feature: 'mso',
		state: 'DGST',
		trace: 'DGCH',
		groups: { d0_d7: 'C1', d8_d15: 'C2' },
		presets: ['TTL', 'CMOS', 'CMOS3.3', 'CMOS2.5', 'CUSTOM'],
	},
	xe: {
		models: 'SDS1000X-E',
		feature: 'mso_xe',
		state: 'DI:SW',
		trace: 'TRA',
		groups: { d0_d7: 'L8', d8_d15: 'H8' },
		presets: ['TTL', 'CMOS', 'LVCMOS33', 'LVCMOS25', 'CUSTOM'],
	},
};

const spelling: Partial<Record<Preset, Preset>> = {
	'CMOS3.3': 'LVCMOS33',
	'CMOS2.5': 'LVCMOS25',
	LVCMOS33: 'CMOS3.3',
	LVCMOS25: 'CMOS2.5',
};

const CUSTOM_LIMIT = 5;
function pickVariant(scope: Scope): Variant {
	scope.requireLegacyDialect();
	const { mso = 'unknown', mso_xe = 'unknown' } = scope.capabilities?.features ?? {};
	const variant: Variant = mso === 'unsupported' && mso_xe !== 'unsupported' ? 'xe' : 'plus';
	scope.requireSupport(variants[variant].feature);
	if (mso === 'unknown' && mso_xe === 'unknown') {
		scope.warn(
			`${scope.identity?.model ?? 'The scope'} has unknown digital support. Assuming the ${variants.plus.models} command set.`,
		);
	}
	return variant;
}

const option = (scope: Scope, variant: Variant): { feature: Feature; support: Support } => ({
	feature: variants[variant].feature,
	support: scope.capabilities?.features[variants[variant].feature] ?? 'unknown',
});

async function readState(session: ScpiSession, variant: Variant) {
	const raw = await session.query(`${variants[variant].state}?`);
	return { enabled: parseState(raw, states) === 'ON', raw };
}

async function readLines(session: ScpiSession, variant: Variant, lines: readonly string[]) {
	const result: Record<string, { enabled: boolean; raw: string }> = {};
	for (const line of lines) {
		const raw = await session.query(`${line}:${variants[variant].trace}?`);
		result[line] = { enabled: parseState(raw, states) === 'ON', raw };
	}
	return result;
}

async function readThreshold(session: ScpiSession, scope: Scope, variant: Variant, group: Group) {
	const { groups: names, presets: allowed } = variants[variant];
	const name = names[group];
	if (variant === 'xe') {
		const raw = await session.query(`${name}:TSM?`);
		const mode = parseState(raw, allowed);
		const custom = mode === 'CUSTOM' ? asQuantity(await session.query(`${name}:CUS?`)) : undefined;
		return { group, name, mode, custom, raw };
	}
	const raw = await session.query(`${name}:DGTH?`);
	const [first = '', level] = parseFields(raw);
	const mode = parseState(first, allowed);
	if (mode === undefined && level !== undefined) {
		scope.warn(`The threshold response ${JSON.stringify(raw)} was not recognized. The mode is returned unparsed.`);
	}
	return { group, name, mode, custom: level === undefined ? undefined : asQuantity(level), raw };
}

async function readThresholds(session: ScpiSession, scope: Scope, variant: Variant, wanted: readonly Group[]) {
	const thresholds = [];
	for (const group of wanted) thresholds.push(await readThreshold(session, scope, variant, group));
	return thresholds;
}

const threshold = z
	.object({
		mode: z.enum(presets).describe('Threshold preset for the group. Custom selects the custom level.'),
		custom: thresholdVolts
			.optional()
			.describe("Custom threshold, for example '3V', '-500MV', or '1.5'. Requires Custom mode."),
	})
	.refine(({ mode, custom }) => custom === undefined || mode === 'CUSTOM', {
		message: 'custom requires mode CUSTOM',
		path: ['custom'],
	});

function encodeThreshold(scope: Scope, variant: Variant, group: Group, input: z.output<typeof threshold>): string[] {
	const { models, groups: names, presets: allowed } = variants[variant];
	const name = names[group];
	const { mode, custom } = input;
	if (!allowed.some((preset) => preset === mode)) {
		const hint = spelling[mode];
		throw new UnsupportedError(
			`${models} models support threshold presets ${allowed.join(', ')}.${hint ? ` Use ${hint} instead of ${mode}.` : ` ${mode} is not supported.`}`,
		);
	}
	if (custom !== undefined) {
		if (variant === 'xe') {
			scope.warn(`The custom threshold range varies by model. ${custom} was sent unchecked and may be clamped.`);
		} else if (Math.abs(parseQuantity(custom)?.value ?? 0) > CUSTOM_LIMIT) {
			throw new UnsupportedError(
				`${custom} is outside the -5V to 5V custom threshold range. Choose a value within the range.`,
			);
		}
	}
	return variant === 'xe'
		? plan(`${name}:TSM ${mode}`, custom && `${name}:CUS ${custom}`)
		: [`${name}:DGTH ${custom ? `${mode},${custom}` : mode}`];
}

export const digitalTools = [
	tool({
		name: 'get_digital',
		description:
			'Read the digital function state, visibility of the requested lines D0-D15, and thresholds of the D0-D7 and D8-D15 groups. MSO option support is reported because it cannot be inferred from the model name.',
		input: z.object({
			lines: z
				.array(digital)
				.default([...digitals])
				.describe('Digital lines to read. Defaults to D0-D15.'),
		}),
		annotations: readOnly,
		handler: ({ lines }, scope) =>
			scope.execute(async (session) => {
				const variant = pickVariant(scope);
				return {
					variant,
					option: option(scope, variant),
					enabled: await readState(session, variant),
					lines: await readLines(session, variant, lines),
					thresholds: await readThresholds(session, scope, variant, groups),
				};
			}),
	}),
	tool({
		name: 'configure_digital',
		description:
			'Turn the digital function on or off, show or hide individual lines D0-D15, and set thresholds for the D0-D7 and D8-D15 groups. Threshold preset names differ between SDS2000X/SDS1000X and SDS1000X-E.',
		input: z.object({
			enabled: z.boolean().optional().describe('Turn the digital function on or off.'),
			lines: z
				.partialRecord(digital, z.boolean())
				.optional()
				.describe('Display state per digital line, e.g. { D0: true, D8: false }'),
			thresholds: z
				.partialRecord(z.enum(groups), threshold)
				.optional()
				.describe("Thresholds for the D0-D7 and D8-D15 groups, for example { d0_d7: { mode: 'CMOS3.3' } }."),
		}),
		annotations: mutating,
		handler: ({ enabled, lines, thresholds }, scope) =>
			scope.execute(async (session) => {
				const variant = pickVariant(scope);
				const wanted = Object.entries(thresholds ?? {}) as Array<[Group, z.output<typeof threshold>]>;
				const commands = plan(
					enabled !== undefined && `${variants[variant].state} ${onOff(enabled)}`,
					...Object.entries(lines ?? {}).map(([line, on]) => `${line}:${variants[variant].trace} ${onOff(on)}`),
					...wanted.flatMap(([group, spec]) => encodeThreshold(scope, variant, group, spec)),
				);
				for (const command of commands) await session.command(command);
				return {
					variant,
					commands,
					state: {
						...(enabled === undefined ? {} : { enabled: await readState(session, variant) }),
						...(lines === undefined ? {} : { lines: await readLines(session, variant, Object.keys(lines)) }),
						...(wanted.length === 0
							? {}
							: {
									thresholds: await readThresholds(
										session,
										scope,
										variant,
										wanted.map(([group]) => group),
									),
								}),
					},
				};
			}),
	}),
];
