import type { ScpiSession } from '../../scpi/connection.ts';
import { type Identity, Instrument, UnsupportedError, warn } from '../../scpi/instrument.ts';
import { asQuantity, type Quantity, stripHeader } from '../../scpi/values.ts';
import { type Capabilities, describeModel, older, probesResolution } from './models.ts';

export const RESOLUTION = ':ACQuire:RESolution';

export const channels = ['C1', 'C2', 'C3', 'C4'] as const;
export type Channel = (typeof channels)[number];

const adcBits = /^(\d+)\s*Bits?$/i;

export class ScpiScope extends Instrument {
	capabilities?: Capabilities;
	// Set from the CLI's --enable-lock flag: only then may a tool engage the remote lock. Unlocking is always allowed.
	allowLock = false;
	// The remote lock state read at startup, for the banner. Undefined until the driver's prepare has run.
	remoteLock?: boolean;

	override status() {
		return { ...super.status(), capabilities: this.capabilities };
	}

	// The one runtime fact this driver probes, and the source of truth for the ADC state the waveform tools report:
	// every read refreshes the cached capability, so a resolution someone else changed cannot go stale here.
	async readResolution(session: ScpiSession): Promise<{ bits?: number; raw: string }> {
		const raw = await session.query(`${RESOLUTION}?`);
		const bits = Number(adcBits.exec(raw.trim())?.[1]) || undefined;
		if (this.capabilities) this.capabilities.resolution = { bits };
		return { bits, raw };
	}

	requireChannel(channel: Channel): void {
		const available = this.capabilities?.channels;
		if (available !== undefined && Number(channel.slice(1)) > available) {
			throw new UnsupportedError(
				`${this.identity?.model} has ${available} analog channels. Choose an available channel instead of ${channel}`,
			);
		}
	}

	override async identify(session: ScpiSession): Promise<Identity> {
		const identity = await super.identify(session);
		const capabilities = describeModel(identity.model);
		this.capabilities = capabilities;
		if (capabilities.firmware && older(identity.firmware, capabilities.firmware)) {
			this.warn(
				`${identity.model} reports firmware ${identity.firmware}, older than the supported ${capabilities.firmware}. Some commands may be unavailable`,
			);
		}
		if (capabilities.channels === undefined) {
			this.warn(
				`${identity.model} does not state its analog channel count in its model number, so no channel is refused before it is sent`,
			);
		}
		if (probesResolution(identity.model)) await this.readResolution(session);
		return identity;
	}
}

// An integer answer the scope cannot give a number for keeps its raw text, gets no value and never becomes 0.
export const counted =
	(what: string) =>
	(raw: string): number | { raw: string } => {
		const text = stripHeader(raw);
		const value = text === '' ? Number.NaN : Number(text);
		if (Number.isFinite(value)) return value;
		warn(`${what} answered ${JSON.stringify(text)} rather than a number`);
		return { raw };
	};

// A reading the scope cannot give a number for keeps its raw text, gets no value and never becomes 0.
export function reading(scope: ScpiScope, what: string, raw: string, why: string): Quantity | { raw: string } {
	const value = asQuantity(raw);
	if (!('value' in value)) {
		scope.warn(`${what} answered ${JSON.stringify(stripHeader(raw))} rather than a number: ${why}`);
	}
	return value;
}
