import * as z from 'zod';
import { channels, outputs } from '../supply.ts';

export * from '../../../tools/schema.ts';

export const channel = z.enum(channels).default('CH1').describe('Programmable channel');
export const output = z.enum(outputs).default('CH1').describe('Output channel. CH3 is available on SPD3303 only.');

// The SPD sets take plain decimals without unit suffixes; both sources answer with three decimals ('3.000').
export const decimal = (value: unknown): string => Number(value).toFixed(3);

// The sources give no setting grammar beyond their examples, so the schema bounds are generous and the
// documented per-model output ratings are enforced separately, before the first write.
export const volts = z.number().min(0).max(100);
export const amps = z.number().min(0).max(100);

// The timer runs each group for up to 10000 s (SPD1000X manual p. 45).
export const dwell = z.number().min(0).max(10_000);

const octet = /^(0|[1-9]\d{0,2})$/;

export const dotted = (label: string) =>
	z
		.string()
		.refine((value) => {
			const fields = value.split('.');
			return fields.length === 4 && fields.every((field) => octet.test(field) && Number(field) <= 255);
		}, 'Enter four decimal octets from 0 to 255 without leading zeros.')
		.describe(label);
