import { type Resolution, resolveFamily } from '../families.ts';

export type { Resolution } from '../families.ts';

export interface Capabilities {
	family: string;
	channels?: number;
	// The oldest firmware the guide's Supported Models table lists for these commands; older firmware warns.
	firmware?: string;
	// Seeded from the family declaration for the banner and status only, refreshed from :ACQuire:RESolution? where
	// the guide documents that query (SDS2000X Plus). Waveform scaling belongs to :WAVeform:PREamble?, never to this.
	resolution: Resolution;
}

// Supported Models, guide p. 18, in the order the table prints them. The model strings are inferred from the series
// names, which is why an unmatched model simply carries no floor rather than a guessed one.
const floors: Array<[RegExp, string]> = [
	[/^SDS5\d{3}X/i, '0.9.0'],
	[/^SDS2\d{3}X[ -]?Plus/i, '1.3.5R3'],
	[/^SDS6\d{3}\s?(A|Pro)/i, '1.1.7.0'],
	[/^SHS(8\d{2}|1\d{3})X/i, '1.1.9'],
	[/^SDS2\d{3}X[ -]?HD/i, '1.2.0.2'],
	[/^SDS6\d{3}L/i, '1.0.1.0'],
	[/^SDS1\d{3}X[ -]?HD/i, '1.1.0.2'],
	[/^SDS7\d{3}A/i, '1.0.7.0'],
	[/^SDS8\d{2}X[ -]?HD/i, '1.1.3.1'],
	[/^SDS3\d{3}X[ -]?HD/i, '1.0.3.0'],
];

// Horizontal divisions across the screen, which the time of the first waveform point is measured from: the guide
// gives 10 for every SDS series it lists and 12 for the SHS handhelds (p. 695), and defines no query for it.
export const horizontalGrid = (model: string): number => (/^SHS/i.test(model) ? 12 : 10);

// The guide's :ACQuire:RESolution section (p. 43) names the SDS2000X Plus and no other model, so the handshake asks
// only that family: an undocumented query blocks for the whole timeout and tears the connection down.
export const probesResolution = (model: string): boolean => /^SDS2\d{3}X[ -]?Plus/i.test(model);

const digits = (value: string): number[] => (value.match(/\d+/g) ?? []).map(Number);

export function older(firmware: string, floor: string): boolean {
	const [left, right] = [digits(firmware), digits(floor)];
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference < 0;
	}
	return false;
}

// The trailing digit of the model number is the analog channel count on every series the guide lists except the
// SHS800X, whose names end in 0 (SHS810X): the guide states no count for those, so none is claimed and no channel
// is refused there.
export function describeModel(model: string): Capabilities {
	const family = resolveFamily(model);
	return {
		family: family?.family ?? 'unknown',
		channels: Number(/^S[DH]S\d*(\d)/.exec(model)?.[1]) || undefined,
		firmware: floors.find(([pattern]) => pattern.test(model))?.[1],
		resolution: { ...family?.declaration.resolution },
	};
}
