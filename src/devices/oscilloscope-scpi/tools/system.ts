import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import { elapsed } from '../../../observability.ts';
import { onOff, plan } from '../../../scpi/commands.ts';
import { requestSignal, ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { UnsupportedError } from '../../../scpi/instrument.ts';
import { asState, isOn, parseFields, parseState, quoted, unquote } from '../../../scpi/values.ts';
import {
	applied,
	compare,
	flag,
	inputs,
	list,
	type Param,
	param,
	readback,
	settings,
	type Values,
} from '../../../tools/params.ts';
import { counted } from '../scope.ts';
import { destructive, mutating, readOnly, tool } from './define.ts';

const SELFCAL = ':SYSTem:SELFCal';
const REBOOT = ':SYSTem:REBoot';
const SHUTDOWN = ':SYSTem:SHUTdown';
const EDUMODE = ':SYSTem:EDUMode';
const LAN_TYPE = ':SYSTem:COMMunicate:LAN:TYPE';
const LAN_MAC = ':SYSTem:COMMunicate:LAN:MAC';
const LAN_ADDRESS = ':SYSTem:COMMunicate:LAN:IPADdress';
const MOUNT = ':SYSTem:NSTorage';
const MOUNT_STATUS = ':SYSTem:NSTorage:STATus';
const MOUNT_CONNECT = ':SYSTem:NSTorage:CONNect';
const MOUNT_DISCONNECT = ':SYSTem:NSTorage:DISConnect';
const CALIBRATION_TIMEOUT = 300_000;
const CALIBRATION_POLL = 2_000;

const clocks = ['EXT', 'IN_ON', 'IN_OFF'] as const;
const savers = ['OFF', '1MIN', '5MIN', '10MIN', '30MIN', '60MIN'] as const;
const lanTypes = ['STATIC', 'DHCP'] as const;
const calibration = ['DOING', 'DONE'] as const;
const languages = [
	'SCHinese',
	'TCHinese',
	'ENGLish',
	'FRENch',
	'JAPanese',
	'KORean',
	'DEUTsch',
	'ESPan',
	'RUSSian',
	'ITALiana',
	'PORTuguese',
] as const;

const grouped = (raw: string, pattern: RegExp, separator: string): string =>
	raw.trim().replace(pattern, (...groups) => groups.slice(1, 4).join(separator));

// The guide calls the time 8-digit NR1 and then spells it out as hour, minute and second; its own example sends six
// digits (p. 406), which is what this takes. Both fields travel as digits and come back as ISO text.
const clock = (
	name: string,
	mnemonic: string,
	schema: z.ZodType,
	what: string,
	pattern: RegExp,
	separator: string,
) => ({
	...param(name, mnemonic, schema, what, (raw) => grouped(raw, pattern, separator)),
	wire: (value: unknown) => String(value).replaceAll(separator, ''),
});

const params: Param[] = [
	flag('buzzer', ':SYSTem:BUZZer', 'sound the buzzer', isOn),
	param(
		'clock_source',
		':SYSTem:CLOCk',
		z.enum(clocks),
		'clock source: EXT is external and disables the 10 MHz output, IN_ON and IN_OFF are internal with that output on or off',
		(raw) => asState(raw, clocks),
	),
	clock('date', ':SYSTem:DATE', z.iso.date(), 'system date as YYYY-MM-DD', /^(\d{4})(\d{2})(\d{2})$/, '-'),
	param('language', ':SYSTem:LANGuage', z.enum(languages), 'display language', (raw) => asState(raw, languages)),
	flag('power_on_line', ':SYSTem:PON', 'reboot on its own once power comes back', isOn),
	flag(
		'remote_lock',
		':SYSTem:REMote',
		'remote control, which locks the touch screen, front panel and peripherals',
		isOn,
	),
	param('screensaver', ':SYSTem:SSAVer', z.enum(savers), 'idle time after which the monitor is blanked', (raw) =>
		asState(raw, savers),
	),
	clock(
		'time',
		':SYSTem:TIME',
		z.iso.time({ precision: 0 }),
		'system time as HH:MM:SS',
		/^(\d{2})(\d{2})(\d{2})$/,
		':',
	),
	flag('touch_screen', ':SYSTem:TOUCh', 'touch screen', isOn),
];

// :SYSTem:MENU is documented for models with a menu switch only (p. 399) and nothing in *IDN? tells those apart, so
// this row carries no parser: it is written and never read, because the query would stall on a model without one.
const menu = flag(
	'menu',
	':SYSTem:MENU',
	'Menu bar on screen. Available on models with a menu switch and never read back',
);

// The lock names the function, not the lock: ON leaves the function usable, OFF is what education mode locks away.
const education: Param[] = [
	flag('autosetup_enabled', 'AUTOSet', 'Leave Auto Setup usable. False locks it'),
	flag('measure_enabled', 'MEASure', 'Leave measurements usable. False locks them'),
	flag('cursors_enabled', 'CURSor', 'Leave cursors usable. False locks them'),
];

const writable = [...params, menu];
const all = [...writable, ...education];

const lan: Param[] = [
	{
		...param('gateway', ':SYSTem:COMMunicate:LAN:GATeway', z.ipv4(), 'default gateway', unquote),
		wire: quoted,
	},
	{ ...param('address', LAN_ADDRESS, z.ipv4(), 'IPv4 address of the scope', unquote), wire: quoted },
	{ ...param('netmask', ':SYSTem:COMMunicate:LAN:SMASk', z.ipv4(), 'subnet mask', unquote), wire: quoted },
	param(
		'lan_type',
		LAN_TYPE,
		z.enum(lanTypes),
		'STATIC keeps the addresses configured here, DHCP takes them from the network',
		(raw) => asState(raw, lanTypes),
	),
	param(
		'vnc_port',
		':SYSTem:COMMunicate:VNCPort',
		z.number().int().min(5900).max(5999),
		'VNC port, 5900 to 5999',
		counted('vnc_port'),
	),
];

const bit = (name: string, mnemonic: string, what: string): Param => ({
	...flag(name, mnemonic, what, (raw) => raw.trim() === '1'),
	wire: (value) => (value ? '1' : '0'),
});

// Quoted ASCII in the guide; everything with a meaning in the command grammar is excluded, so no value can end the
// string it travels in or start a second command.
const text = (max: number) =>
	z
		.string()
		.max(max)
		.regex(/^[^"',;\r\n]*$/, 'no quotes, commas, semicolons or line breaks');

const storage: Param[] = [
	{
		...param(
			'path',
			'path',
			z
				.string()
				.min(1)
				.max(128)
				.regex(/^[^"',;\s]+$/, 'no quotes, commas, semicolons or whitespace'),
			'server path to mount, e.g. //10.12.255.239/nfs',
			unquote,
		),
		wire: quoted,
	},
	{ ...param('user', 'user', text(64), 'user name, empty for none', unquote), wire: quoted },
	{
		...param('password', 'pwd', text(64), 'Password. It travels in clear text and is returned as ***', unquote),
		wire: quoted,
	},
	bit('anonymous', 'anon', 'mount anonymously'),
	bit('auto_connect', 'auto_con', 'mount again on its own'),
	bit('remember_path', 'rem_path', 'keep the path for the next mount'),
	bit('remember_user', 'rem_user', 'keep the user name for the next mount'),
	bit('remember_password', 'rem_pwd', 'keep the password for the next mount'),
];

// The line is positional, so a field left out still travels: the ones the request does not name travel as empty and 0.
const empty: Values = {
	user: '',
	password: '',
	anonymous: false,
	auto_connect: false,
	remember_path: false,
	remember_user: false,
	remember_password: false,
};

function decodeEducation(raw: string): Values {
	const state: Values = {};
	for (const entry of raw.trim().split(';')) {
		const [func = '', lock = ''] = entry.split(',').map((field) => field.trim());
		const row = education.find((p) => p.mnemonic.toUpperCase() === func.toUpperCase());
		if (row && lock) state[row.name] = isOn(lock);
	}
	return state;
}

function decodeStorage(raw: string): Values {
	const fields = parseFields(raw);
	const state: Values = { raw };
	storage.forEach((row, index) => {
		const field = fields[index];
		if (field !== undefined) state[row.name] = row.parse?.(field) ?? field;
	});
	return state;
}

// `only` limits the read-back to what a request set; without it the whole table is read.
async function readSettings(session: ScpiSession, only?: Values): Promise<Values> {
	const state = await readback(session, only ? applied(params, only) : params);
	if (only && !education.some(({ name }) => only[name] !== undefined)) return state;
	const raw = await session.query(`${EDUMODE}?`);
	return { ...state, ...decodeEducation(raw), education_mode_raw: raw };
}

const readMount = async (session: ScpiSession): Promise<Values> => ({
	...decodeStorage(await session.query(`${MOUNT}?`)),
	connected: isOn(await session.query(`${MOUNT_STATUS}?`)),
});

export const systemTools = [
	tool({
		name: 'get_system_settings',
		description:
			'Read the buzzer, clock, language, power-on, remote lock, screensaver, touch screen, education-mode and self-calibration settings. Education fields report whether each function is usable. The menu setting is unavailable because some models do not support reading it.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => ({
				...(await readSettings(session)),
				self_calibration: asState(await session.query(`${SELFCAL}?`), calibration),
			})),
	}),
	tool({
		name: 'configure_system_settings',
		description:
			'Set system settings and read back the requested values. Set an education field to false to lock Auto Setup, measurements or cursors. Engaging the remote lock requires the server to run with the enable-lock flag and is refused before anything is sent otherwise. Releasing it is always accepted. The menu setting has no supported read-back and is reported under write_only.',
		input: z.strictObject(inputs(all)),
		annotations: mutating,
		handler: (input: Values, scope) => {
			if (input.remote_lock === true && !scope.allowLock) {
				throw new UnsupportedError(
					'Locking the front panel requires the server to run with --enable-lock. Remove remote_lock or restart the server with the flag. Unlocking with remote_lock false is always accepted',
				);
			}
			const locks = applied(education, input).map(
				({ name, mnemonic }) => `${EDUMODE} ${mnemonic},${onOff(input[name] as boolean)}`,
			);
			const commands = plan(...settings(writable, input), ...locks);
			return scope.execute(async (session) => {
				for (const command of commands) await session.command(command);
				const state = await readSettings(session, input);
				compare(scope, all, input, state);
				return { commands, state, ...(input.menu !== undefined && { write_only: [menu.mnemonic] }) };
			});
		},
	}),
	tool({
		name: 'get_lan_configuration',
		description: 'Read the gateway, IPv4 address, subnet mask, address mode, MAC address and VNC port.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute(async (session) => ({
				...(await readback(session, lan)),
				mac: (await session.query(`${LAN_MAC}?`)).trim(),
			})),
	}),
	tool({
		name: 'configure_lan',
		description:
			"Change the scope's address mode, IPv4 address, subnet mask, gateway and VNC port. Changing the address or enabling DHCP may end the current connection. Requires confirm_network: true. Nothing is sent otherwise.",
		input: z
			.object({
				...inputs(lan),
				confirm_network: z
					.literal(true)
					.describe('Explicit acknowledgement that the network settings change and this connection may die'),
			})
			.refine(
				({ lan_type, address, netmask, gateway }: Values) => !(lan_type === 'DHCP' && (address || netmask || gateway)),
				'DHCP replaces the static configuration. Choose DHCP or provide static addresses, not both',
			)
			.refine(
				(input: Values) => lan.some(({ name }) => input[name] !== undefined),
				'No parameters given, nothing to configure',
			),
		annotations: destructive,
		exposure: 'dangerous',
		handler: (input: Values, scope) => {
			const { address, lan_type } = input;
			const staged = { ...input, address: undefined, lan_type: undefined };
			const statics = address ?? input.netmask ?? input.gateway;
			return scope.execute(async (session) => {
				const commands: string[] = [];
				const send = async (command: string) => {
					commands.push(command);
					await session.command(command);
				};
				if (lan_type === 'STATIC') await send(`${LAN_TYPE} STATIC`);
				else if (statics !== undefined && asState(await session.query(`${LAN_TYPE}?`), lanTypes) === 'DHCP') {
					scope.warn(
						'The scope is using DHCP, which supplies its address, netmask and gateway. Set lan_type to Static to keep these values',
					);
				}
				for (const command of settings(lan, staged)) await send(command);
				const state = await readback(session, applied(lan, staged));
				if (lan_type === 'STATIC') state.lan_type = asState(await session.query(`${LAN_TYPE}?`), lanTypes);
				compare(scope, lan, input, state);
				if (typeof address === 'string') {
					const previous = unquote(await session.query(`${LAN_ADDRESS}?`));
					if (previous === address) return { commands, state, changed: false, previous };
					for (const command of settings(lan, { address })) await send(command);
					const { host, port } = scope.target;
					scope.retire(`The scope moved to ${address}. The connection to ${host}:${port} is stale`);
					return {
						commands,
						state,
						changed: true,
						previous,
						target: { host: address, port },
						read_back: 'Skipped because changing the address closes the connection.',
						connection: 'retired',
						reconnect: `Restart the server with ${address}:${port}. Calls will fail until then`,
					};
				}
				if (lan_type === 'DHCP') {
					await send(`${LAN_TYPE} DHCP`);
					scope.warn(
						'DHCP may move the scope to another address. If it stops answering, restart the server with the new address',
					);
					return {
						commands,
						state,
						read_back: 'Skipped because DHCP may change the address and close the connection.',
					};
				}
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'get_network_storage',
		description: 'Read the configured network drive and whether it is mounted. The password is returned as ***.',
		annotations: readOnly,
		handler: (_, scope) => scope.execute(readMount),
	}),
	tool({
		name: 'configure_network_storage',
		description:
			'Set the network drive and optionally mount or unmount it, then read the configuration back. Omitted fields are cleared, which is why this call is destructive. The password travels to the scope in clear text and appears in the echoed command. The read-back masks it as ***. Provide path, connect, or both.',
		input: z
			.object({
				...inputs(storage),
				connect: z.boolean().optional().describe('true mounts the drive, false unmounts it'),
			})
			.refine(({ path, connect }: Values) => path !== undefined || connect !== undefined, 'give path, connect or both'),
		annotations: destructive,
		handler: ({ connect, ...input }: Values & { connect?: boolean }, scope) => {
			const mount = input.path === undefined ? undefined : `${MOUNT} ${list(storage, { ...empty, ...input })}`;
			const echo = input.password ? `${MOUNT} ${list(storage, { ...empty, ...input, password: '***' })}` : mount;
			const action = connect === undefined ? undefined : connect ? MOUNT_CONNECT : MOUNT_DISCONNECT;
			const commands = [...(mount ? [mount] : []), ...(action ? [action] : [])];
			return scope.execute(async (session) => {
				if (input.password) scope.warn('The network-drive password travels to the scope in clear text.');
				if (mount) await session.command(mount, undefined, echo === mount ? undefined : echo);
				if (action) await session.command(action);
				const state = await readMount(session);
				compare(
					scope,
					storage.filter(({ name }) => name !== 'password'),
					input,
					state,
				);
				return { commands, state };
			});
		},
	}),
	tool({
		name: 'calibrate_scope',
		description:
			'Run self-calibration and wait for completion. Disconnect everything from the inputs first. The scope is unavailable during calibration and may continue calibrating after a timeout closes the connection. Requires confirm_inputs_disconnected: true. Nothing is sent otherwise.',
		input: z.object({
			confirm_inputs_disconnected: z
				.literal(true)
				.describe('Explicit acknowledgement that every input is disconnected and the scope may go out of service'),
			timeout_ms: z
				.number()
				.int()
				.min(10_000)
				.max(900_000)
				.optional()
				.describe(
					'Calibration timeout in milliseconds, default 300000. Each wait for an answer is also bounded by the server response ceiling, 180000 by default, so a calibration that runs longer needs --max-response-timeout raised.',
				),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: ({ timeout_ms }, scope) =>
			scope.execute(async (session) => {
				scope.warn('Self-calibration takes the scope out of service until it completes');
				const started = performance.now();
				const deadline = started + (timeout_ms ?? CALIBRATION_TIMEOUT);
				await session.command(SELFCAL);
				const status = () => session.query(`${SELFCAL}?`, Math.max(1_000, deadline - performance.now()));
				let raw = await status();
				while (parseState(raw, calibration) === 'DOING' && performance.now() < deadline) {
					await delay(CALIBRATION_POLL, undefined, { signal: requestSignal() }).catch(() => undefined);
					raw = await status();
				}
				if (parseState(raw, calibration) !== 'DONE') {
					throw new ScpiError(`Self-calibration did not report success: ${JSON.stringify(raw)}`);
				}
				return { commands: [SELFCAL], calibrated: true, duration_ms: elapsed(started), raw };
			}),
	}),
	tool({
		name: 'reboot_scope',
		description:
			'Restart the scope. The connection drops during restart and unsaved settings are lost. Requires confirm_reboot: true. Nothing is sent otherwise.',
		input: z.object({
			confirm_reboot: z
				.literal(true)
				.describe('Explicit acknowledgement that the scope restarts and this connection drops'),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command(REBOOT);
				return { commands: [REBOOT], connection: 'Dropped while the scope restarts. A later call reconnects' };
			}),
	}),
	tool({
		name: 'shutdown_scope',
		description:
			'Shut the scope down. It stops answering until switched on at the instrument, unless power_on_line is enabled and power is cycled. Requires confirm_shutdown: true. Nothing is sent otherwise.',
		input: z.object({
			confirm_shutdown: z
				.literal(true)
				.describe('Explicit acknowledgement that the scope powers off and answers nothing until it is switched on'),
		}),
		annotations: destructive,
		exposure: 'dangerous',
		handler: (_, scope) =>
			scope.execute(async (session) => {
				await session.command(SHUTDOWN);
				return { commands: [SHUTDOWN], connection: 'Dropped. The scope answers again only after it is switched on' };
			}),
	}),
];
