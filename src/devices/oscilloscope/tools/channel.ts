import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseKeyValues, stripHeader } from '../../../scpi/values.ts';
import { applied, flag, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Channel } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { channel, scpiValue, volts } from './schema.ts';

const attenuations = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;

const coupling = z.enum(['A1M', 'A50', 'D1M', 'D50', 'GND']);

const timeScale: Record<string, number> = { S: 1, MS: 1e-3, US: 1e-6, NS: 1e-9 };

const skew = scpiValue.refine((value) => {
	const [, digits = '', unit = ''] = /^([-+]?\d+(?:\.\d+)?(?:E[-+]?\d+)?)([A-Za-z]*)$/i.exec(value) ?? [];
	const scale = timeScale[unit.toUpperCase()];
	return scale !== undefined && Math.abs(Number(digits) * scale) <= 100e-9;
}, "time with unit within ±100 ns, e.g. '3NS' or '-9.9E-08S'");

const params = [
	param('probe_attenuation', 'ATTN', z.literal(attenuations), 'probe attenuation factor, 0.1 to 10000', asQuantity),
	param('volts_per_div', 'VDIV', volts, "volts per division, 500uV to 10V, e.g. '500mV' or '1V'", asQuantity),
	param(
		'offset',
		'OFST',
		volts,
		"Vertical offset, for example '-500mV'. The allowed range depends on volts per division.",
		asQuantity,
	),
	param('coupling', 'CPL', coupling, 'A1M=AC 1MOhm, A50=AC 50Ohm, D1M=DC 1MOhm, D50=DC 50Ohm, GND', stripHeader),
	param('skew', 'SKEW', skew, "channel-to-channel deskew, -100NS to 100NS, e.g. '3NS'", asQuantity),
	param('unit', 'UNIT', z.enum(['V', 'A']), 'measurement unit of the probe', stripHeader),
	flag('inverted', 'INVS', 'invert the trace', stripHeader),
	flag('trace', 'TRA', 'show or hide the trace', stripHeader),
];

// `only` limits the read-back to what a request set; without it the whole channel is read.
export async function readChannel(session: ScpiSession, ch: Channel, only?: Values) {
	return {
		channel: ch,
		...(await readback(session, only ? applied(params, only) : params, `${ch}:`)),
		...(only && only.bandwidth_limit === undefined
			? {}
			: { bandwidth_limit: parseKeyValues(await session.query('BWL?'))[ch] ?? 'unknown' }),
	};
}

export const channelTools = [
	tool({
		name: 'get_channel',
		description:
			'Read an analog channel configuration, including volts per division, offset, coupling, bandwidth limit, visibility, probe attenuation, unit, skew, and inversion.',
		input: z.object({ channel }),
		annotations: readOnly,
		handler: ({ channel: ch }, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(ch);
				return readChannel(session, ch);
			}),
	}),
	tool({
		name: 'configure_channel',
		description:
			'Configure an analog channel. Only the provided settings change. Probe attenuation is applied before scale and offset.',
		input: z.object({
			channel,
			...inputs(params),
			bandwidth_limit: z.boolean().optional().describe('Enable or disable the 20 MHz bandwidth limit.'),
		}),
		annotations: mutating,
		handler: (input, scope) => {
			const ch = input.channel;
			const commands = plan(
				...settings(params, input, `${ch}:`),
				input.bandwidth_limit !== undefined && `BWL ${ch},${onOff(input.bandwidth_limit)}`,
			);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				scope.requireChannel(ch);
				for (const command of commands) await session.command(command);
				return { commands, state: await readChannel(session, ch, input) };
			});
		},
	}),
];
