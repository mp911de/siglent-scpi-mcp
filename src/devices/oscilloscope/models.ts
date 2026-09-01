import { type Dialect, type Guide, type Resolution, resolveFamily } from '../families.ts';

export type { Dialect, Guide, Resolution } from '../families.ts';

export type Support = 'supported' | 'unsupported' | 'unknown';
export type Feature = 'base' | 'spo' | 'xe' | 'mso' | 'mso_xe' | 'awg' | 'obsolete';

export interface Capabilities {
	family: string;
	dialect: Dialect;
	// which of the guide's four command tables the model follows; undefined for a model no table lists.
	guide?: Guide;
	channels?: number;
	spo?: boolean;
	resolution: Resolution;
	features: Record<Feature, Support>;
}

const eightBit: Resolution = { bits: 8, codesPerDivision: 25 };

const yes = 'supported';
const no = 'unsupported';
const option = 'unknown';

const availability: Record<Feature, Record<Guide, Support>> = {
	base: { xe: yes, '1000x': yes, '2000x': yes, nonSpo: yes },
	spo: { xe: yes, '1000x': yes, '2000x': yes, nonSpo: no },
	xe: { xe: yes, '1000x': no, '2000x': no, nonSpo: no },
	mso: { xe: no, '1000x': option, '2000x': option, nonSpo: no },
	mso_xe: { xe: option, '1000x': no, '2000x': no, nonSpo: no },
	awg: { xe: no, '1000x': option, '2000x': option, nonSpo: no },
	obsolete: { xe: no, '1000x': option, '2000x': option, nonSpo: option },
};

export const features = Object.keys(availability) as Feature[];

export function describeModel(model: string): Capabilities {
	const known = resolveFamily(model);
	const declaration = known?.declaration;
	const channels = Number(/^SDS\d*(\d)/.exec(model)?.[1]) || undefined;
	const support = (feature: Feature): Support =>
		declaration?.guide ? availability[feature][declaration.guide] : known ? 'unsupported' : 'unknown';
	const entries = features.map((feature) => [feature, support(feature)] as const);
	return {
		family: known?.family ?? 'unknown',
		dialect: declaration?.dialect ?? 'unknown',
		guide: declaration?.guide,
		channels,
		spo: declaration?.spo,
		resolution: declaration?.resolution ?? (declaration?.guide ? eightBit : {}),
		features: Object.fromEntries(entries) as Record<Feature, Support>,
	};
}
