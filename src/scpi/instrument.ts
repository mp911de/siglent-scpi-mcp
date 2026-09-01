import { log } from '../observability.ts';
import type { ScreenshotStore } from '../screenshots.ts';
import {
	type ConnectionOptions,
	type ExchangeInterceptor,
	ScpiConnection,
	ScpiError,
	type ScpiSession,
	type Target,
	warn,
	withWarnings,
} from './connection.ts';

export { warn, withWarnings };

export interface Identity {
	manufacturer: string;
	model: string;
	serial: string;
	firmware: string;
	raw: string;
}

export function parseIdentity(raw: string): Identity {
	const [manufacturer = '', model = '', serial = '', firmware = ''] = raw.split(',').map((field) => field.trim());
	return { manufacturer, model, serial, firmware, raw };
}

export class UnsupportedError extends Error {}

export interface InstrumentOptions extends Omit<ConnectionOptions, 'onConnect'> {
	intercept?: ExchangeInterceptor;
	// The model the target is known to answer as; a different answer retires the connection instead of serving it.
	expect?: string;
}

export class Instrument {
	readonly target: Target;
	identity?: Identity;
	// Set from the CLI's --save-screenshots flag: screenshot tools also write each capture to disk when present.
	screenshots?: ScreenshotStore;
	#expected?: string;
	readonly #connection: ScpiConnection;

	constructor(target: Target, { intercept, expect, ...options }: InstrumentOptions = {}) {
		this.target = target;
		this.#expected = expect;
		this.#connection = new ScpiConnection(
			target,
			{ ...options, onConnect: (session) => this.handshake(session) },
			intercept,
		);
	}

	get connected(): boolean {
		return this.#connection.connected;
	}

	execute<T>(work: (session: ScpiSession) => Promise<T>): Promise<T> {
		return this.#connection.execute(work);
	}

	warn(message: string): void {
		warn(message);
	}

	retire(reason: string): void {
		this.#connection.retire(reason);
	}

	close(): Promise<void> {
		return this.#connection.close();
	}

	status() {
		return { connected: this.connected, target: this.target, identity: this.identity };
	}

	async identify(session: ScpiSession): Promise<Identity> {
		const identity = parseIdentity(await session.query('*IDN?'));
		if (!identity.model) {
			throw new ScpiError(
				`The instrument returned an invalid identification response: ${JSON.stringify(identity.raw)}`,
			);
		}
		this.identity = identity;
		return identity;
	}

	// Every connect re-identifies; an answer from a different model than the probe saw retires the connection, so a
	// reused address never silently swaps instruments mid-session.
	protected async handshake(session: ScpiSession): Promise<void> {
		const { model } = await this.identify(session);
		if (this.#expected && model !== this.#expected) {
			const { host, port } = this.target;
			const reason = `${host}:${port} now identifies as ${model}, not ${this.#expected}. Restart the server to use the new instrument.`;
			this.retire(reason);
			throw new ScpiError(reason);
		}
		log().debug({ identity: this.identity }, 'instrument connected');
	}
}
