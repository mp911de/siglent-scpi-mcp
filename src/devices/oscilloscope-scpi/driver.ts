import type { InstrumentOptions } from '../../scpi/instrument.ts';
import { isOn } from '../../scpi/values.ts';
import { dialectOf } from '../families.ts';
import type { Driver } from '../index.ts';
import { ScpiScope } from './scope.ts';
import { tools } from './tools/index.ts';

const REMOTE = ':SYSTem:REMote';

export const oscilloscopeScpi: Driver<ScpiScope> = {
	kind: 'oscilloscope',
	label: 'oscilloscope (EN11F)',
	matches: (model: string) => dialectOf(model) === 'scpi',
	create: (target, options?: InstrumentOptions) => new ScpiScope(target, options),
	tools,
	instructions: `Controls a Siglent oscilloscope through typed tools.
Use scpi_query and scpi_command only when no typed tool covers the operation.
A raw query that does not answer before the timeout closes the connection.`,
	async prepare(scope, { unlock, allowLock }) {
		scope.allowLock = allowLock;
		await scope.execute(async (session) => {
			scope.remoteLock = isOn(await session.query(`${REMOTE}?`));
			if (scope.remoteLock && unlock) {
				await session.command(`${REMOTE} OFF`);
				scope.remoteLock = isOn(await session.query(`${REMOTE}?`));
			}
		});
	},
	describe(scope) {
		const { identity, capabilities, remoteLock } = scope;
		if (!identity || !capabilities) return { facts: [], warnings: [] };
		const { bits } = capabilities.resolution;
		const facts = [
			capabilities.family,
			`${capabilities.channels ?? '?'} channels`,
			...(bits ? [`${bits}-bit`] : []),
			...(remoteLock === undefined ? [] : [`remote lock ${remoteLock ? 'on' : 'off'}`]),
			`firmware ${identity.firmware}`,
		];
		const warnings = remoteLock
			? [
					'The scope front panel is locked by remote control. Restart with --unlock to release it, or call configure_system_settings with remote_lock false.',
				]
			: [];
		return { facts, warnings };
	},
};
