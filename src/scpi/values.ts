export interface Quantity {
	value: number;
	unit?: string;
	raw: string;
}

const header = /^\*?[A-Z][A-Z0-9_:]*\??\s+(?=\S)/i;
const quantity = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z/%]*)$/;
const prefixes: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, G: 1e9 };
const upper: Record<string, number> = { P: 1e-12, N: 1e-9, U: 1e-6, K: 1e3 };
const mega = new Set(['Hz', 'Sa/s', 'pts', 'W']);
const units = new Set(['V', 'A', 's', 'S', 'Hz', 'Sa/s', 'pts', 'dB', 'dBm', 'Vrms', 'W', 'Ohm', '%', 'rad', 'degree']);

const scaleOf = (prefix: string, base: string): number | undefined =>
	prefix === 'M' ? (mega.has(base) ? 1e6 : 1e-3) : (prefixes[prefix] ?? upper[prefix]);

export const stripHeader = (raw: string): string => raw.trim().replace(header, '');

export const unquote = (raw: string): string => raw.trim().replace(/^"(.*)"$/s, '$1');

export const quoted = (value: unknown): string => `"${value}"`;

export const isOn = (raw: string): boolean => stripHeader(raw).toUpperCase() === 'ON';

export function parseQuantity(raw: string): Quantity | undefined {
	const match = quantity.exec(stripHeader(raw));
	if (!match) return undefined;
	const unit = match[2] || undefined;
	if (!unit || units.has(unit)) return { value: Number(match[1]), unit, raw };
	const base = unit.slice(1);
	const scale = units.has(base) ? scaleOf(unit.charAt(0), base) : undefined;
	return scale === undefined ? undefined : { value: Number(match[1]) * scale, unit: base, raw };
}

export const asQuantity = (raw: string): Quantity | { raw: string } => parseQuantity(raw) ?? { raw };

export const asQuantities = (fields: Record<string, string>): Record<string, Quantity | { raw: string }> =>
	Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, asQuantity(value)]));

// The uppercase prefix of a mixed-case state is its SCPI short form: HIGh answers as HIG.
const shortForm = /^([^a-z]+)[a-z]+$/;

export function parseState<T extends string>(raw: string, states: readonly T[]): T | undefined {
	const value = stripHeader(raw).toUpperCase();
	const exact = states.find((state) => state.toUpperCase() === value);
	if (exact) return exact;
	const abbreviated = states.filter((state) => shortForm.exec(state)?.[1] === value);
	return abbreviated.length === 1 ? abbreviated[0] : undefined;
}

export const asState = <T extends string>(raw: string, states: readonly T[]): T | { raw: string } =>
	parseState(raw, states) ?? { raw };

export function parseFields(raw: string, tag?: string): string[] {
	const body = stripHeader(raw);
	const fields = body ? body.split(',').map((field) => field.trim()) : [];
	return fields[0] === tag ? fields.slice(1) : fields;
}

export function parseKeyValues(raw: string, from = 0): Record<string, string> {
	const fields = parseFields(raw).slice(from);
	const result: Record<string, string> = {};
	for (let index = 0; index + 1 < fields.length; index += 2) result[fields[index] ?? ''] = fields[index + 1] ?? '';
	return result;
}
