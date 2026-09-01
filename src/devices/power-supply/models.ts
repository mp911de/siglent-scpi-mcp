import { type PsuSet, resolveFamily } from '../families.ts';

export type { PsuSet } from '../families.ts';

export type Support = 'supported' | 'unsupported' | 'unknown';

export const features = [
	'powerMeasure',
	'ovpOcp',
	'timer',
	'wireMode',
	'waveDisplay',
	'track',
	'fixedThirdChannel',
	'lanConfig',
	'deleteSavedStates',
] as const;
export type Feature = (typeof features)[number];

export interface Rating {
	volts: number;
	amps: number;
}

export interface Capabilities {
	family: string;
	set?: PsuSet;
	// programmable channels; the SPD3303 set adds a fixed CH3 that is switchable but not programmable.
	channels?: number;
	rating?: Rating;
	features: Record<Feature, Support>;
}

const sets: Record<PsuSet, { channels: number; features: Record<Feature, boolean> }> = {
	SPD1000X: {
		channels: 1,
		features: {
			powerMeasure: true,
			ovpOcp: true,
			timer: true,
			wireMode: true,
			waveDisplay: true,
			track: false,
			fixedThirdChannel: false,
			lanConfig: true,
			deleteSavedStates: true,
		},
	},
	SPD3303: {
		channels: 2,
		features: {
			powerMeasure: false,
			ovpOcp: false,
			timer: false,
			wireMode: false,
			waveDisplay: false,
			track: true,
			fixedThirdChannel: true,
			lanConfig: false,
			deleteSavedStates: false,
		},
	},
};

// The output ratings the sources state: SPD1168X 16 V / 8 A and SPD1305X 30 V / 5 A (SPD1000X manual p. 18),
// SPD3303C 0-32 V / 0-3.2 A per channel (quickstart p. 15). The SPD3303X/X-E rating is in neither source.
const ratings: Record<string, Rating> = {
	SPD1168X: { volts: 16, amps: 8 },
	SPD1305X: { volts: 30, amps: 5 },
	SPD3303C: { volts: 32, amps: 3.2 },
};

export function describeSupply(model: string): Capabilities {
	const known = resolveFamily(model);
	const set = known?.declaration.psu;
	const table = set ? sets[set] : undefined;
	const support = (feature: Feature): Support =>
		table ? (table.features[feature] ? 'supported' : 'unsupported') : 'unknown';
	return {
		family: known?.family ?? 'unknown',
		set,
		channels: table?.channels,
		rating: ratings[model],
		features: Object.fromEntries(features.map((feature) => [feature, support(feature)])) as Record<Feature, Support>,
	};
}
