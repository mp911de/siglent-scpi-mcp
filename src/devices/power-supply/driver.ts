import type { InstrumentOptions } from '../../scpi/instrument.ts';
import { detectKind } from '../families.ts';
import type { Driver } from '../index.ts';
import { PowerSupply } from './supply.ts';
import { tools } from './tools/index.ts';

export const powerSupply: Driver<PowerSupply> = {
	kind: 'power-supply',
	label: 'power-supply driver',
	matches: (model: string) => detectKind(model) === 'power-supply',
	create: (target, options?: InstrumentOptions) => new PowerSupply(target, options),
	tools,
	instructions: `Controls a Siglent SPD power supply over SCPI. Prefer typed tools. Use scpi_query and scpi_command
only for operations without a typed tool. Values are plain decimals without unit suffixes, for example 3.000 for 3 V.
Feature availability differs between SPD families. Unsupported operations are refused.`,
	// The SPD lock has no query, so nothing is reported: --unlock sends the unlock and the state stays unknown.
	async prepare(supply, { unlock }) {
		await supply.execute(async (session) => {
			if (unlock) await session.command('*UNLOCK');
		});
	},
	describe(supply) {
		const { identity, capabilities } = supply;
		if (!identity || !capabilities) return { facts: [], warnings: [] };
		const { channels, features } = capabilities;
		const facts = [
			capabilities.family,
			channels === undefined
				? 'unknown channels'
				: `${channels} programmable channel${channels === 1 ? '' : 's'}${features.fixedThirdChannel === 'supported' ? ' + fixed CH3' : ''}`,
			`firmware ${identity.firmware}`,
		];
		const warnings =
			capabilities.set === undefined
				? ['This model is outside the recognized SPD families. Its command support is unknown.']
				: [];
		return { facts, warnings };
	},
};
