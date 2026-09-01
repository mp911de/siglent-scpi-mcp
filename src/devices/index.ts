import type * as z from 'zod';
import type { Target } from '../scpi/connection.ts';
import type { Instrument, InstrumentOptions } from '../scpi/instrument.ts';
import type { ToolDefinition } from '../tools/define.ts';
import type { DeviceKind } from './families.ts';
import { oscilloscope } from './oscilloscope/driver.ts';
import { oscilloscopeScpi } from './oscilloscope-scpi/driver.ts';
import { powerSupply } from './power-supply/driver.ts';
import { unknown } from './unknown.ts';

export { applyInventory, type DeviceKind, detectKind } from './families.ts';

// The CLI's front-panel lock intent, which each driver maps onto its own commands.
export interface LockIntent {
	unlock: boolean;
	allowLock: boolean;
}

export interface Driver<I extends Instrument = Instrument> {
	readonly kind: DeviceKind;
	// Distinguishes drivers that share a kind, such as the two oscilloscope dialects.
	readonly label: string;
	matches(model: string): boolean;
	create(target: Target, options?: InstrumentOptions): I;
	readonly tools: readonly ToolDefinition<z.ZodObject, I>[];
	readonly instructions: string;
	// Connects and applies the lock intent for instruments with a lock this driver knows how to drive.
	prepare?(instrument: I, locks: LockIntent): Promise<void>;
	describe(instrument: I): { facts: string[]; warnings: string[] };
}

// The last driver matches everything, so an unrecognized instrument still gets identify, status and raw SCPI.
const drivers: readonly Driver[] = [oscilloscopeScpi, oscilloscope, powerSupply, unknown];

export const selectDriver = (model: string): Driver => drivers.find((driver) => driver.matches(model)) ?? unknown;
