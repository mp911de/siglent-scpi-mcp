import * as z from 'zod';
import { elapsed } from '../../../observability.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { parseState, stripHeader } from '../../../scpi/values.ts';
import { headerModes } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';
import { singleLine, timeoutMs } from './schema.ts';

// PG01-E02C gives no duration for *CAL? and locks the front panel for all of it, so the read is bounded far above
// any plausible procedure; a timeout closes the connection while the scope keeps calibrating.
const CALIBRATION_TIMEOUT = 300_000;

const calibrationTimeoutMs = z
	.number()
	.int()
	.min(10_000)
	.max(900_000)
	.optional()
	.describe('Calibration timeout in milliseconds, default 300000');

const decimal = /^(0|[1-9]\d{0,2})$/;

// The guide's own grammar (p. 179): first octet 1-223 except 127, the rest 0-255. Leading zeros are rejected rather
// than read as octal, and nothing but four decimal fields ever reaches the wire.
function octets(value: string, separator: string): number[] | undefined {
	const fields = value.split(separator);
	if (fields.length !== 4 || !fields.every((field) => decimal.test(field))) return undefined;
	const [first = 0, ...rest] = fields.map(Number);
	if (first < 1 || first > 223 || first === 127 || rest.some((field) => field > 255)) return undefined;
	return [first, ...rest];
}

const ipv4 = z
	.string()
	.refine((value) => octets(value, '.') !== undefined, 'IPv4 address, first octet 1-223 except 127, the rest 0-255')
	.describe("IPv4 address for the scope's network interface, e.g. '10.11.0.230'");

async function readAddress(session: ScpiSession) {
	const raw = await session.query('CONET?');
	return { address: octets(stripHeader(raw), ',')?.join('.'), raw };
}

export async function waitUntilComplete(session: ScpiSession, timeout?: number) {
	const raw = await session.query('*OPC?', timeout);
	if (stripHeader(raw) !== '1')
		throw new ScpiError(`The scope did not report completion. Response: ${JSON.stringify(raw)}`);
	return { completed: true, raw };
}

async function readHeader(session: ScpiSession) {
	const raw = await session.query('CHDR?');
	return { mode: parseState(raw, headerModes), raw };
}

export const systemTools = [
	// Scope.identify sends *IDN? and enriches its response with derived capabilities.
	tool({
		name: 'identify',
		description:
			'Identify the connected oscilloscope. Returns the manufacturer, model, serial number, firmware, derived family, command dialect, and channel count.',
		annotations: readOnly,
		handler: async (_, scope) => {
			const identity = await scope.execute((session) => scope.identify(session));
			return { ...identity, capabilities: scope.capabilities, target: scope.target };
		},
	}),
	tool({
		name: 'wait_until_complete',
		description:
			'Wait until all pending scope operations have finished. Blocks the connection until the scope answers or the timeout expires. A timeout closes the connection.',
		input: z.object({ timeout_ms: timeoutMs }),
		annotations: readOnly,
		handler: ({ timeout_ms }, scope) => scope.execute((session) => waitUntilComplete(session, timeout_ms)),
	}),
	tool({
		name: 'mark_operation_complete',
		description:
			'Set the operation-complete bit in the Standard Event Status Register after pending operations finish. The command has no query form. Use wait_until_complete when the caller must wait for completion.',
		annotations: mutating,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command('*OPC');
				return { commands: ['*OPC'] };
			}),
	}),
	tool({
		name: 'reset_scope',
		description:
			'Reset the scope to factory defaults, wait for completion, restore the communication header, and identify the scope again. Requires `confirm_reset: true`. Nothing is sent otherwise.',
		input: z.object({
			confirm_reset: z.literal(true).describe('Explicit acknowledgement that all scope settings are discarded'),
			timeout_ms: timeoutMs.describe('Completion timeout in milliseconds, default 30000'),
		}),
		annotations: destructive,
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				await session.command('*RST');
				const reset = await waitUntilComplete(session, timeout_ms ?? 30_000);
				const identity = await scope.identify(session);
				return { commands: ['*RST'], reset, identity, capabilities: scope.capabilities, header: scope.header };
			}),
	}),
	tool({
		name: 'get_communication_header',
		description:
			'Read the response header mode. Off omits headers and units. Short and Long prefix responses with the short or long command name. The server sets Off when connecting.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				return readHeader(session);
			}),
	}),
	tool({
		name: 'configure_communication_header',
		description:
			'Set the response header mode. Typed tools support every mode. Raw SCPI query responses preserve the header. The selected mode is restored after reconnecting.',
		input: z.object({ mode: z.enum(headerModes) }),
		annotations: mutating,
		handler: ({ mode }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				await session.command(`CHDR ${mode}`);
				const header = await readHeader(session);
				if (!header.mode)
					throw new ScpiError(
						`The scope returned an unrecognized communication header mode: ${JSON.stringify(header.raw)}`,
					);
				scope.header = header.mode;
				return { commands: [`CHDR ${mode}`], ...header };
			}),
	}),
	tool({
		name: 'calibrate_scope',
		description:
			'Run the user self-calibration. The scope stops acquisition, disables the front-panel keys, and holds the connection until calibration finishes. Disconnect every input first. Requires `confirm_inputs_disconnected: true`. Nothing is sent otherwise. The default timeout is 300 seconds, bounded by the server response ceiling of 180000 ms by default, so a longer calibration needs --max-response-timeout raised. A timeout closes the connection while the scope continues calibrating.',
		input: z.object({
			confirm_inputs_disconnected: z
				.literal(true)
				.describe('Explicit acknowledgement that every input is disconnected and the scope may go out of service'),
			timeout_ms: calibrationTimeoutMs,
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.warn('Self-calibration disables the front-panel keys and stops acquisition until the scope answers.');
				const started = performance.now();
				const raw = await session.query('*CAL?', timeout_ms ?? CALIBRATION_TIMEOUT);
				const code = stripHeader(raw);
				if (code !== '0') throw new ScpiError(`Self-calibration did not report success: ${JSON.stringify(raw)}`);
				return { commands: ['*CAL?'], calibrated: true, code: 0, duration_ms: elapsed(started), raw };
			}),
	}),
	tool({
		name: 'get_network_address',
		description:
			"Read the IPv4 address of the scope's network interface. Netmask, gateway, and DHCP state are not available. An invalid address is returned only as raw text.",
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				return readAddress(session);
			}),
	}),
	tool({
		name: 'change_scope_ip',
		description:
			"Change the scope's IPv4 address. This disconnects the server from the scope. Calls fail until the server is restarted with the new address. DHCP must be disabled, but its state cannot be checked. Requires `confirm_disconnect: true`. Nothing is sent when the address is unchanged.",
		input: z.object({
			address: ipv4,
			confirm_disconnect: z
				.literal(true)
				.describe('Explicit acknowledgement that this connection dies and the scope answers only at the new address'),
		}),
		annotations: destructive,
		handler: ({ address }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				const previous = await readAddress(session);
				if (previous.address === address) return { commands: [], changed: false, previous };
				scope.warn(
					'The DHCP state cannot be checked. If DHCP is enabled, the scope may ignore or replace the address.',
				);
				const command = `CONET ${address.replaceAll('.', ',')}`;
				const { host, port } = scope.target;
				await session.command(command);
				scope.retire(`The scope was moved to ${address}. The connection to ${host}:${port} is stale.`);
				return {
					commands: [command],
					changed: true,
					previous,
					target: { host: address, port },
					read_back: 'Skipped because changing the address closes the connection.',
					connection: 'retired',
					reconnect: `Restart the server with ${address}:${port}. Calls fail until then.`,
				};
			}),
	}),
	tool({
		name: 'scpi_query',
		description:
			'Send a raw SCPI query and return its text response. Use this only when no typed tool is available. Some queries have side effects. Responses follow the communication header mode. The default Off mode returns values only.',
		input: z.object({
			command: singleLine.regex(/\?/, 'A SCPI query must contain ?.').describe("SCPI query, for example 'C1:VDIV?'"),
			timeout_ms: timeoutMs,
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command, timeout_ms }, scope) =>
			scope.execute(async (session) => ({ commands: [command], response: await session.query(command, timeout_ms) })),
	}),
	tool({
		name: 'scpi_command',
		description: 'Send a raw SCPI command without reading a response. Use this only when no typed tool is available.',
		input: z.object({
			command: singleLine
				.refine((value) => !value.includes('?'), 'A command must not be a query. Use scpi_query instead.')
				.describe("SCPI command, for example 'C1:VDIV 500mV'"),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ command }, scope) =>
			scope.execute(async (session) => {
				await session.command(command);
				return { commands: [command] };
			}),
	}),
];
