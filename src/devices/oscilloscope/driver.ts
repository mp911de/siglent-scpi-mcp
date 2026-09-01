import type { InstrumentOptions } from '../../scpi/instrument.ts';
import { detectKind, dialectOf } from '../families.ts';
import type { Driver } from '../index.ts';
import { Scope } from './scope.ts';
import { tools } from './tools/index.ts';

export const oscilloscope: Driver<Scope> = {
	kind: 'oscilloscope',
	label: 'oscilloscope (PG01-E02C)',
	matches: (model: string) => detectKind(model) === 'oscilloscope' && dialectOf(model) !== 'scpi',
	create: (target, options?: InstrumentOptions) => new Scope(target, options),
	tools,
	instructions: `Controls a Siglent oscilloscope through typed tools.
Use scpi_query and scpi_command only when no typed tool covers the operation.
Values are strings with units as the scope expects them, for example '500mV', '1V', and '10us'.`,
	describe(scope) {
		const { identity, capabilities } = scope;
		if (!identity || !capabilities) return { facts: [], warnings: [] };
		const { bits } = capabilities.resolution;
		const facts = [
			capabilities.family,
			`${capabilities.channels ?? '?'} channels`,
			bits ? `${bits}-bit` : 'unknown resolution',
			`firmware ${identity.firmware}`,
		];
		const warnings = [];
		if (capabilities.dialect === 'unknown') warnings.push('Unknown model family: command support is unverified');
		return { facts, warnings };
	},
};
