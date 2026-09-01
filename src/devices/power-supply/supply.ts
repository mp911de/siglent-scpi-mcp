import type { ScpiSession } from '../../scpi/connection.ts';
import { type Identity, Instrument, UnsupportedError } from '../../scpi/instrument.ts';
import { type Capabilities, describeSupply, type Feature } from './models.ts';

export const channels = ['CH1', 'CH2'] as const;
export type Channel = (typeof channels)[number];

export const outputs = ['CH1', 'CH2', 'CH3'] as const;
export type Output = (typeof outputs)[number];

const labels: Record<Feature, string> = {
	powerMeasure: 'power measurement',
	ovpOcp: 'over-voltage and over-current protection',
	timer: 'timer configuration',
	wireMode: 'wire mode configuration',
	waveDisplay: 'waveform display control',
	track: 'track mode',
	fixedThirdChannel: 'the fixed CH3 output',
	lanConfig: 'network configuration',
	deleteSavedStates: 'deleting saved states',
};

export class PowerSupply extends Instrument {
	capabilities?: Capabilities;

	override status() {
		return { ...super.status(), capabilities: this.capabilities };
	}

	// No CHDR handshake: the SPD command set has no communication-header concept, *IDN? alone identifies.
	override async identify(session: ScpiSession): Promise<Identity> {
		const identity = await super.identify(session);
		this.capabilities = describeSupply(identity.model);
		return identity;
	}

	requireDocumented(): void {
		if (!this.capabilities?.set)
			this.warn(
				`${this.identity?.model ?? 'This supply'} is outside the recognized SPD families. Its command support is unknown.`,
			);
	}

	require(feature: Feature): void {
		const support = this.capabilities?.features[feature] ?? 'unknown';
		if (support === 'unsupported') {
			const { model } = this.identity ?? {};
			throw new UnsupportedError(
				`${model} does not support ${labels[feature]}. Choose an operation supported by this model.`,
			);
		}
		if (support === 'unknown') this.requireDocumented();
	}

	requireChannel(channel: Channel): void {
		const available = this.capabilities?.channels;
		if (available !== undefined && Number(channel.slice(2)) > available) {
			throw new UnsupportedError(
				`${this.identity?.model} has ${available} programmable channel${available === 1 ? '' : 's'}. Choose an available channel.`,
			);
		}
	}

	requireOutput(channel: Output): void {
		if (channel === 'CH3') this.require('fixedThirdChannel');
		else this.requireChannel(channel);
	}
}
