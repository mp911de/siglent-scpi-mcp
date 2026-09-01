import type { ScpiSession } from '../../scpi/connection.ts';
import { type Identity, Instrument, UnsupportedError } from '../../scpi/instrument.ts';
import { type Capabilities, describeModel, type Feature } from './models.ts';
import { forgetPanelSetups } from './tools/setups.ts';

export { UnsupportedError, withWarnings } from '../../scpi/instrument.ts';

export const channels = ['C1', 'C2', 'C3', 'C4'] as const;
export type Channel = (typeof channels)[number];

export const headerModes = ['OFF', 'SHORT', 'LONG'] as const;
export type HeaderMode = (typeof headerModes)[number];

export class Scope extends Instrument {
	capabilities?: Capabilities;
	header: HeaderMode = 'OFF';

	override status() {
		return { ...super.status(), capabilities: this.capabilities };
	}

	override close(): Promise<void> {
		forgetPanelSetups();
		return super.close();
	}

	requireLegacyDialect(): void {
		const dialect = this.capabilities?.dialect;
		if (dialect === 'scpi') {
			throw new UnsupportedError(`${this.identity?.model} does not support this operation.`);
		}
		if (dialect !== 'legacy')
			this.warn(`${this.identity?.model ?? 'The scope'} is not a recognized model. Command support is unknown.`);
	}

	require(feature: Feature): void {
		this.requireLegacyDialect();
		this.requireSupport(feature);
	}

	requireSupport(feature: Feature): void {
		const { model = 'unknown model' } = this.identity ?? {};
		const { family = 'unknown', dialect } = this.capabilities ?? {};
		const support = dialect === 'unknown' ? 'unknown' : (this.capabilities?.features[feature] ?? 'unknown');
		if (support === 'unsupported') {
			throw new UnsupportedError(`${model} (${family}) does not support ${feature} commands.`);
		}
		if (support === 'unknown') this.warn(`Support for ${feature} commands on ${model} (${family}) is unknown`);
	}

	requireChannel(channel: Channel): void {
		const available = this.capabilities?.channels;
		if (available !== undefined && Number(channel.slice(1)) > available) {
			throw new UnsupportedError(
				`${this.identity?.model} has ${available} channels. Choose an available channel instead of ${channel}.`,
			);
		}
	}

	override async identify(session: ScpiSession): Promise<Identity> {
		await session.command(`CHDR ${this.header}`);
		const identity = await super.identify(session);
		this.capabilities = describeModel(identity.model);
		return identity;
	}
}
