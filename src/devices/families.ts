import * as z from 'zod';

export const kinds = ['oscilloscope', 'power-supply', 'unknown'] as const;
export type DeviceKind = (typeof kinds)[number];

export type Dialect = 'legacy' | 'scpi' | 'unknown';
export type Guide = 'xe' | '1000x' | '2000x' | 'nonSpo';
export const psuSets = ['SPD1000X', 'SPD3303'] as const;
export type PsuSet = (typeof psuSets)[number];

export interface Resolution {
	bits?: number;
	codesPerDivision?: number;
}

export type ModelMatch = string | { pattern: RegExp };

export interface FamilyDeclaration {
	kind: DeviceKind;
	dialect?: Dialect;
	spo?: boolean;
	guide?: Guide;
	psu?: PsuSet;
	resolution?: Resolution;
	models: readonly ModelMatch[];
}

const sds = (declaration: Omit<FamilyDeclaration, 'kind'>): FamilyDeclaration => ({
	kind: 'oscilloscope',
	...declaration,
});

// Declaration order decides among patterns, so SDS1000X-E stays ahead of the barer SDS1000X.
const builtin: Record<string, FamilyDeclaration> = {
	'SDS1000X-E': sds({ dialect: 'legacy', spo: true, guide: 'xe', models: [{ pattern: /^SDS1\d{3}X-E$/ }] }),
	'SDS1000X-C': sds({ dialect: 'legacy', spo: true, guide: 'xe', models: [{ pattern: /^SDS1\d{3}X-C$/ }] }),
	SDS1000X: sds({ dialect: 'legacy', spo: true, guide: '1000x', models: [{ pattern: /^SDS1\d{3}X\+?$/ }] }),
	SDS2000X: sds({ dialect: 'legacy', spo: true, guide: '2000x', models: [{ pattern: /^SDS2\d{3}X?$/ }] }),
	'SDS1000 non-SPO': sds({
		dialect: 'legacy',
		spo: false,
		guide: 'nonSpo',
		models: [{ pattern: /^SDS1\d{3}(CFL|A|CML\+|CNL\+|DL\+|E\+|F\+)$/ }],
	}),
	'SDS X HD': sds({
		dialect: 'scpi',
		spo: true,
		resolution: { bits: 12 },
		models: [{ pattern: /^SDS\d{3,4}X[ -]?HD$/i }],
	}),
	'SDS X Plus': sds({ dialect: 'scpi', spo: true, models: [{ pattern: /^SDS\d{3,4}X[ -]?Plus$/i }] }),
	'SDS5000X/6000/7000': sds({ dialect: 'scpi', spo: true, models: [{ pattern: /^SDS[5-7]\d{3}/ }] }),
	'SHS800X/SHS1000X': sds({ dialect: 'scpi', spo: true, models: [{ pattern: /^SHS(8\d{2}|1\d{3})X$/i }] }),
	SPD1000X: { kind: 'power-supply', psu: 'SPD1000X', models: ['SPD1168X', 'SPD1305X'] },
	// The SPD3303X/X-E entries are an inference: only the SPD3303C document spells the command set out.
	SPD3303: { kind: 'power-supply', psu: 'SPD3303', models: ['SPD3303X', 'SPD3303X-E', 'SPD3303C'] },
};

const compilable = (pattern: string): boolean => {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
};

const models = z
	.array(
		z.union([
			z.string().min(1),
			z.strictObject({ pattern: z.string().min(1).refine(compilable, 'valid regular expression') }),
		]),
	)
	.min(1);

const declaration = z.strictObject({
	kind: z.enum(['oscilloscope', 'power-supply']),
	dialect: z.enum(['legacy', 'scpi', 'unknown']).optional(),
	spo: z.boolean().optional(),
	guide: z.enum(['xe', '1000x', '2000x', 'nonSpo']).optional(),
	psu: z.enum(psuSets).optional(),
	resolution: z
		.strictObject({ bits: z.number().int().positive().optional(), codesPerDivision: z.number().positive().optional() })
		.optional(),
	models,
});

// A key naming a built-in family may carry models alone; a new family must declare what its models are.
export const inventory = z.record(z.string().min(1), z.union([declaration, z.strictObject({ models })]));

interface Layer {
	family: string;
	declaration: FamilyDeclaration;
	models: readonly ModelMatch[];
}

const layered = (table: Record<string, FamilyDeclaration>): Layer[] =>
	Object.entries(table).map(([family, declaration]) => ({ family, declaration, models: declaration.models }));

let layers = layered(builtin);

const compile = (model: string | { pattern: string }): ModelMatch =>
	typeof model === 'string' ? model : { pattern: new RegExp(model.pattern) };

export function applyInventory(raw: unknown): string[] {
	const parsed = inventory.safeParse(raw);
	if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
	const warnings: string[] = [];
	const overlay: Layer[] = [];
	for (const [family, entry] of Object.entries(parsed.data)) {
		const compiled = entry.models.map(compile);
		const base = builtin[family];
		if ('kind' in entry) overlay.push({ family, declaration: { ...entry, models: compiled }, models: compiled });
		else if (base) overlay.push({ family, declaration: base, models: compiled });
		else warnings.push(`Inventory family '${family}' matches no built-in family and declares no kind. It is ignored.`);
	}
	layers = [...overlay, ...layered(builtin)];
	return warnings;
}

export interface ResolvedFamily {
	family: string;
	declaration: FamilyDeclaration;
}

// Exact model strings always win over patterns; among patterns, inventory entries beat built-in ones and
// declaration order decides the rest.
export function resolveFamily(model: string): ResolvedFamily | undefined {
	const match =
		layers.find(({ models }) => models.includes(model)) ??
		layers.find(({ models }) => models.some((entry) => typeof entry !== 'string' && entry.pattern.test(model)));
	return match && { family: match.family, declaration: match.declaration };
}

export const dialectOf = (model: string): Dialect | undefined => resolveFamily(model)?.declaration.dialect;

export function detectKind(model: string): DeviceKind {
	const known = resolveFamily(model);
	if (known) return known.declaration.kind;
	if (/^S(DS|HS)/i.test(model)) return 'oscilloscope';
	if (/^SPD/i.test(model)) return 'power-supply';
	return 'unknown';
}
