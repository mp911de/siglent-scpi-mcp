// One row per guide parameter: public name, wire mnemonic, schema and, where the guide has a query, how to parse it.
import * as z from 'zod';
import { onOff } from '../scpi/commands.ts';
import type { ScpiSession } from '../scpi/connection.ts';
import type { Instrument } from '../scpi/instrument.ts';
import { parseQuantity } from '../scpi/values.ts';

const RELATIVE = 1e-3;
const EPSILON = 1e-9;

export interface Param {
	name: string;
	mnemonic: string;
	schema: z.ZodType;
	description: string;
	parse?(raw: string): unknown;
	// a value the guide writes differently from the way the API takes it, e.g. TRUART:BAUD CUSTOM,2000 for 2000.
	wire?(value: unknown): string;
	floor?: number;
}

export type Values = Record<string, unknown>;
type Parse = Param['parse'];

export const param = (name: string, mnemonic: string, schema: z.ZodType, what: string, parse?: Parse): Param => ({
	name,
	mnemonic,
	schema,
	description: what,
	parse,
});

export const flag = (name: string, mnemonic: string, what: string, parse?: Parse): Param =>
	param(name, mnemonic, z.boolean(), what, parse);

// A row the scope clamps to the nearest value it can take: compared with a relative tolerance that never falls below
// floor, because a bare relative tolerance collapses to zero for a requested 0.
export const clamped = (
	name: string,
	mnemonic: string,
	schema: z.ZodType,
	what: string,
	parse: Parse,
	floor: number,
): Param => ({ ...param(name, mnemonic, schema, what, parse), floor });

const encode = (value: unknown): string => (typeof value === 'boolean' ? onOff(value) : String(value));

const given = (params: readonly Param[], values: Values) =>
	params
		.filter((p) => values[p.name] !== undefined)
		.map((p) => [p.mnemonic, (p.wire ?? encode)(values[p.name])] as const);

export const inputs = (params: readonly Param[]): z.ZodRawShape =>
	Object.fromEntries(params.map((p) => [p.name, p.schema.optional().describe(p.description)]));

export const pairs = (params: readonly Param[], values: Values): string => given(params, values).flat().join(',');

// The positional form of a composite line, where the guide names no mnemonics: DATE 1,NOV,2017,14,38,16.
export const list = (params: readonly Param[], values: Values): string =>
	given(params, values)
		.map(([, value]) => value)
		.join(',');

export const settings = (params: readonly Param[], values: Values, prefix = ''): string[] =>
	given(params, values).map(([mnemonic, value]) => `${prefix}${mnemonic} ${value}`);

// A mutating tool echoes what its own request set; the whole table is what the matching get_ tool is for. One field
// of a serial trigger otherwise costs thirteen queries on a connection every client shares.
export const applied = (params: readonly Param[], values: Values): readonly Param[] =>
	params.filter(({ name }) => values[name] !== undefined);

export async function readback(session: ScpiSession, params: readonly Param[], prefix = ''): Promise<Values> {
	const state: Values = {};
	for (const p of params) if (p.parse) state[p.name] = p.parse(await session.query(`${prefix}${p.mnemonic}?`));
	return state;
}

const scalar = (value: unknown): number | undefined => {
	if (typeof value === 'number') return value;
	if (typeof value === 'string') return parseQuantity(value)?.value;
	const inner = (value as { value?: unknown } | null | undefined)?.value;
	return typeof inner === 'number' ? inner : undefined;
};

const text = (value: unknown): string => String(typeof value === 'boolean' ? onOff(value) : value).toUpperCase();

const show = (value: unknown): string => JSON.stringify(scalar(value) ?? value);

// Numbers are compared as numbers whatever notation the scope answers in; everything else by its parsed text.
function matches({ floor }: Param, wanted: unknown, applied: unknown): boolean {
	const [target, value] = [scalar(wanted), scalar(applied)];
	if (target === undefined || value === undefined) return text(wanted) === text(applied);
	return Math.abs(value - target) <= (floor === undefined ? EPSILON : Math.max(Math.abs(target) * RELATIVE, floor));
}

export function compare(
	instrument: Instrument,
	params: readonly Param[],
	input: Values,
	state: Values,
	why = '',
): void {
	for (const row of params) {
		const wanted = input[row.name];
		if (wanted === undefined || !(row.name in state) || matches(row, wanted, state[row.name])) continue;
		instrument.warn(
			`${row.name} was set to ${JSON.stringify(wanted)} but the scope reports ${show(state[row.name])}${why && ` because ${why}`}`,
		);
	}
}
