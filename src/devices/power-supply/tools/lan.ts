import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { parseState, stripHeader } from '../../../scpi/values.ts';
import { destructive, tool } from './define.ts';
import { dotted } from './schema.ts';

const read = async (session: ScpiSession, query: string) => stripHeader(await session.query(query));

export const lanTools = [
	tool({
		name: 'configure_lan',
		description:
			"Configure the supply's static IPv4 settings or DHCP. Available on SPD1000X only. Set dhcp to false when applying static settings. Changing the IP address closes the current connection. Requires confirm_network: true. Nothing is sent otherwise.",
		input: z
			.object({
				address: dotted('Static IPv4 address').optional(),
				netmask: dotted('Subnet mask').optional(),
				gateway: dotted('Default gateway').optional(),
				dhcp: z.boolean().optional().describe('Use automatic network configuration'),
				confirm_network: z
					.literal(true)
					.describe('Acknowledge that changing network settings may close this connection'),
			})
			.refine(
				({ address, netmask, gateway, dhcp }) => !(dhcp === true && (address || netmask || gateway)),
				'DHCP cannot be enabled with static settings. Set dhcp to false or omit the static settings.',
			),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ address, netmask, gateway, dhcp }, supply) => {
			plan(address, netmask, gateway, dhcp !== undefined ? 'DHCP' : undefined);
			return supply.execute(async (session) => {
				supply.require('lanConfig');
				const commands: string[] = [];
				const send = async (command: string) => {
					commands.push(command);
					await session.command(command);
				};
				const dhcpNow = parseState(await session.query('DHCP?'), ['ON', 'OFF']);
				if ((address || netmask || gateway) && dhcp !== false && dhcpNow !== 'OFF')
					supply.warn('Static network settings are ignored while DHCP is enabled. Set dhcp to false and try again.');
				if (dhcp === false) await send('DHCP OFF');
				if (netmask) await send(`MASKaddr ${netmask}`);
				if (gateway) await send(`GATEaddr ${gateway}`);
				const state: Record<string, unknown> = {};
				if (netmask) state.netmask = await read(session, 'MASKaddr?');
				if (gateway) state.gateway = await read(session, 'GATEaddr?');
				if (dhcp === false) state.dhcp = parseState(await session.query('DHCP?'), ['ON', 'OFF']);
				if (address) {
					const previous = await read(session, 'IPaddr?');
					if (previous === address) return { commands, state, changed: false, previous };
					await send(`IPaddr ${address}`);
					const { host, port } = supply.target;
					supply.retire(`The supply moved to ${address}. The connection to ${host}:${port} is stale.`);
					return {
						commands,
						state,
						changed: true,
						previous,
						target: { host: address, port },
						read_back: 'Skipped because changing the address closes the connection.',
						connection: 'retired',
						reconnect: `Restart the server with ${address}:${port}. Calls will fail until it reconnects.`,
					};
				}
				if (dhcp === true) {
					await send('DHCP ON');
					state.dhcp = parseState(await session.query('DHCP?'), ['ON', 'OFF']);
					supply.warn(
						'DHCP may assign a different address. If the supply stops responding, restart the server with its new address.',
					);
				}
				return { commands, state };
			});
		},
	}),
];
