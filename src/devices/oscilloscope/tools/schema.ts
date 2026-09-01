import * as z from 'zod';
import { channels } from '../scope.ts';

export * from '../../../tools/schema.ts';

export const channel = z.enum(channels).describe('Analog channel');

export const digitals = [
	'D0',
	'D1',
	'D2',
	'D3',
	'D4',
	'D5',
	'D6',
	'D7',
	'D8',
	'D9',
	'D10',
	'D11',
	'D12',
	'D13',
	'D14',
	'D15',
] as const;

export const digital = z.enum(digitals).describe('Digital channel D0-D15 (MSO option)');
