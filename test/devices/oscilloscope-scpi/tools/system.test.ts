import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertInvalidSendsNothing, assertReadOnly, assertSent, payload } from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness, text } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	':SYSTem:BUZZer?': 'ON',
	':SYSTem:CLOCk?': 'IN_ON',
	':SYSTem:DATE?': '20190819',
	':SYSTem:LANGuage?': 'ENGLish',
	':SYSTem:PON?': 'OFF',
	':SYSTem:REMote?': 'OFF',
	':SYSTem:SSAVer?': '10MIN',
	':SYSTem:TIME?': '081040',
	':SYSTem:TOUCh?': 'ON',
	':SYSTem:EDUMode?': 'AUTOSet,ON;MEASure,OFF;CURSor,ON',
	':SYSTem:SELFCal?': 'DONE',
	':SYSTem:COMMunicate:LAN:GATeway?': '"10.12.0.1"',
	':SYSTem:COMMunicate:LAN:IPADdress?': '"10.12.255.229"',
	':SYSTem:COMMunicate:LAN:SMASk?': '"255.255.0.0"',
	':SYSTem:COMMunicate:LAN:TYPE?': 'STATIC',
	':SYSTem:COMMunicate:LAN:MAC?': '00:01:D2:0C:00:A0',
	':SYSTem:COMMunicate:VNCPort?': '5903',
	':SYSTem:NSTorage?': '"//10.12.255.239/nfs","","***",0,0,1,0,0',
	':SYSTem:NSTorage:STATus?': 'OFF',
};

async function connect(extra: Record<string, Reply> = {}): Promise<ScpiHarness> {
	const harness = await startScpiHarness('SDS804X HD', { ...replies, ...extra });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('EN11F system tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('reads every documented setting but the menu switch', async () => {
		const state = payload(await call(harness, 'get_system_settings'));
		expect(state).toBeEqual({
			buzzer: true,
			clock_source: 'IN_ON',
			date: '2019-08-19',
			language: 'ENGLish',
			power_on_line: false,
			remote_lock: false,
			screensaver: '10MIN',
			time: '08:10:40',
			touch_screen: true,
			autosetup_enabled: true,
			measure_enabled: false,
			cursors_enabled: true,
			education_mode_raw: 'AUTOSet,ON;MEASure,OFF;CURSor,ON',
			self_calibration: 'DONE',
		});
		assertSent(harness.fake, [
			':SYSTem:BUZZer?',
			':SYSTem:CLOCk?',
			':SYSTem:DATE?',
			':SYSTem:LANGuage?',
			':SYSTem:PON?',
			':SYSTem:REMote?',
			':SYSTem:SSAVer?',
			':SYSTem:TIME?',
			':SYSTem:TOUCh?',
			':SYSTem:EDUMode?',
			':SYSTem:SELFCal?',
		]);
		await assertReadOnly(harness.client, 'get_system_settings');
	});

	it('writes the date and time as digits and reads back only what it set', async () => {
		const result = payload(await call(harness, 'configure_system_settings', { date: '2019-08-19', time: '08:10:40' }));
		expect(result.commands).toBeEqual([':SYSTem:DATE 20190819', ':SYSTem:TIME 081040']);
		expect(result.state).toBeEqual({ date: '2019-08-19', time: '08:10:40' });
		assertSent(harness.fake, [':SYSTem:DATE 20190819', ':SYSTem:TIME 081040', ':SYSTem:DATE?', ':SYSTem:TIME?']);
	});

	it('locks a function with one EDUMode line per function and reports all three', async () => {
		const result = payload(await call(harness, 'configure_system_settings', { measure_enabled: false, buzzer: true }));
		expect(result.commands).toBeEqual([':SYSTem:BUZZer ON', ':SYSTem:EDUMode MEASure,OFF']);
		expect(result.state).toBeEqual({
			buzzer: true,
			autosetup_enabled: true,
			measure_enabled: false,
			cursors_enabled: true,
			education_mode_raw: 'AUTOSet,ON;MEASure,OFF;CURSor,ON',
		});
		assertSent(harness.fake, [
			':SYSTem:BUZZer ON',
			':SYSTem:EDUMode MEASure,OFF',
			':SYSTem:BUZZer?',
			':SYSTem:EDUMode?',
		]);
	});

	it('refuses to engage the remote lock unless the server allows locking, before anything is sent', async () => {
		const refused = await call(harness, 'configure_system_settings', { remote_lock: true, buzzer: true });
		expect(refused.isError).toBe(true);
		expect(text(refused)).toMatchRegex(/"kind":"unsupported"/);
		expect(text(refused)).toMatchRegex(/--enable-lock/);
		assertSent(harness.fake, []);

		const released = payload(await call(harness, 'configure_system_settings', { remote_lock: false }));
		expect(released.commands).toBeEqual([':SYSTem:REMote OFF']);
		harness.fake.sent();

		harness.scope.allowLock = true;
		try {
			const locked = payload(await call(harness, 'configure_system_settings', { remote_lock: true }));
			expect(locked.commands).toBeEqual([':SYSTem:REMote ON']);
			assertSent(harness.fake, [':SYSTem:REMote ON', ':SYSTem:REMote?']);
		} finally {
			harness.scope.allowLock = false;
		}
	});

	it('writes the menu switch without ever querying it', async () => {
		const result = payload(await call(harness, 'configure_system_settings', { menu: true }));
		expect(result.commands).toBeEqual([':SYSTem:MENU ON']);
		expect(result.write_only).toBeEqual([':SYSTem:MENU']);
		assertSent(harness.fake, [':SYSTem:MENU ON']);
	});

	it('warns about a setting the scope did not take', async () => {
		const result = payload(await call(harness, 'configure_system_settings', { screensaver: 'OFF' }));
		expect((result.warnings as string[]).some((warning) => warning.includes('screensaver'))).toBeTruthy();
		harness.fake.sent();
	});

	it('sends nothing for a system setting outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_system_settings', {});
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { buzzer: true, buzzzer: false });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { date: '2019-02-30' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { time: '08:10' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { language: 'KLINGon' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { screensaver: '2MIN' });
		await assertInvalidSendsNothing(harness, 'configure_system_settings', { clock_source: 'INTernal' });
	});

	it('reads the whole documented network state', async () => {
		const state = payload(await call(harness, 'get_lan_configuration'));
		expect(state).toBeEqual({
			gateway: '10.12.0.1',
			address: '10.12.255.229',
			netmask: '255.255.0.0',
			lan_type: 'STATIC',
			vnc_port: 5903,
			mac: '00:01:D2:0C:00:A0',
		});
		assertSent(harness.fake, [
			':SYSTem:COMMunicate:LAN:GATeway?',
			':SYSTem:COMMunicate:LAN:IPADdress?',
			':SYSTem:COMMunicate:LAN:SMASk?',
			':SYSTem:COMMunicate:LAN:TYPE?',
			':SYSTem:COMMunicate:VNCPort?',
			':SYSTem:COMMunicate:LAN:MAC?',
		]);
		await assertReadOnly(harness.client, 'get_lan_configuration');
	});

	it('sets STATIC before the addresses it protects and quotes every one of them', async () => {
		const result = payload(
			await call(harness, 'configure_lan', {
				lan_type: 'STATIC',
				netmask: '255.255.0.0',
				gateway: '10.12.0.1',
				vnc_port: 5903,
				confirm_network: true,
			}),
		);
		expect(result.commands).toBeEqual([
			':SYSTem:COMMunicate:LAN:TYPE STATIC',
			':SYSTem:COMMunicate:LAN:GATeway "10.12.0.1"',
			':SYSTem:COMMunicate:LAN:SMASk "255.255.0.0"',
			':SYSTem:COMMunicate:VNCPort 5903',
		]);
		expect(result.state).toBeEqual({
			gateway: '10.12.0.1',
			netmask: '255.255.0.0',
			vnc_port: 5903,
			lan_type: 'STATIC',
		});
		harness.fake.sent();
	});

	it('warns when a static address is written while the scope takes its own from DHCP', async () => {
		harness.fake.replies.set(':SYSTem:COMMunicate:LAN:TYPE?', 'DHCP');
		const result = payload(await call(harness, 'configure_lan', { netmask: '255.255.0.0', confirm_network: true }));
		expect((result.warnings as string[]).some((warning) => warning.includes('DHCP'))).toBeTruthy();
		assertSent(harness.fake, [
			':SYSTem:COMMunicate:LAN:TYPE?',
			':SYSTem:COMMunicate:LAN:SMASk "255.255.0.0"',
			':SYSTem:COMMunicate:LAN:SMASk?',
		]);
		harness.fake.replies.set(':SYSTem:COMMunicate:LAN:TYPE?', 'STATIC');
	});

	it('does not send an address the scope already has', async () => {
		const result = payload(await call(harness, 'configure_lan', { address: '10.12.255.229', confirm_network: true }));
		expect(result.commands).toBeEqual([]);
		expect(result.changed).toBe(false);
		assertSent(harness.fake, [':SYSTem:COMMunicate:LAN:TYPE?', ':SYSTem:COMMunicate:LAN:IPADdress?']);
	});

	it('switches to DHCP last and never reads back over a socket it may have killed', async () => {
		const result = payload(await call(harness, 'configure_lan', { lan_type: 'DHCP', confirm_network: true }));
		expect(result.commands).toBeEqual([':SYSTem:COMMunicate:LAN:TYPE DHCP']);
		expect(String(result.read_back)).toMatchRegex(/^Skipped/);
		assertSent(harness.fake, [':SYSTem:COMMunicate:LAN:TYPE DHCP']);
	});

	it('sends nothing for a network request the guide cannot express', async () => {
		await assertInvalidSendsNothing(harness, 'configure_lan', { netmask: '255.255.0.0' });
		await assertInvalidSendsNothing(harness, 'configure_lan', { confirm_network: true });
		await assertInvalidSendsNothing(harness, 'configure_lan', { address: '10.12.255', confirm_network: true });
		await assertInvalidSendsNothing(harness, 'configure_lan', { vnc_port: 80, confirm_network: true });
		await assertInvalidSendsNothing(harness, 'configure_lan', {
			lan_type: 'DHCP',
			address: '10.12.0.5',
			confirm_network: true,
		});
	});

	it('writes a new address last and retires the connection without a read-back', async () => {
		const fresh = await connect();
		try {
			const result = payload(await call(fresh, 'configure_lan', { address: '10.12.0.50', confirm_network: true }));
			expect(result.commands).toBeEqual([':SYSTem:COMMunicate:LAN:IPADdress "10.12.0.50"']);
			expect(result.changed).toBe(true);
			expect(result.previous).toBe('10.12.255.229');
			expect(result.connection).toBe('retired');
			assertSent(fresh.fake, [
				':SYSTem:COMMunicate:LAN:TYPE?',
				':SYSTem:COMMunicate:LAN:IPADdress?',
				':SYSTem:COMMunicate:LAN:IPADdress "10.12.0.50"',
			]);
			const refused = await call(fresh, 'get_lan_configuration');
			expect(refused.isError).toBe(true);
			assertSent(fresh.fake, []);
		} finally {
			await fresh.close();
		}
	});

	it('reads the mounted network drive and its status', async () => {
		const state = payload(await call(harness, 'get_network_storage'));
		expect(state).toBeEqual({
			raw: '"//10.12.255.239/nfs","","***",0,0,1,0,0',
			path: '//10.12.255.239/nfs',
			user: '',
			password: '***',
			anonymous: false,
			auto_connect: false,
			remember_path: true,
			remember_user: false,
			remember_password: false,
			connected: false,
		});
		assertSent(harness.fake, [':SYSTem:NSTorage?', ':SYSTem:NSTorage:STATus?']);
		await assertReadOnly(harness.client, 'get_network_storage');
	});

	it('declares the mount destructive, because the positional line clears omitted fields', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'configure_network_storage')?.annotations;
		expect(annotations?.destructiveHint).toBe(true);
	});

	it('mounts a drive as one positional line, filling in the fields the request leaves out', async () => {
		const result = payload(
			await call(harness, 'configure_network_storage', {
				path: '//10.12.255.239/nfs',
				password: 'secret',
				remember_path: true,
				connect: true,
			}),
		);
		expect(result.commands).toBeEqual([
			':SYSTem:NSTorage "//10.12.255.239/nfs","","secret",0,0,1,0,0',
			':SYSTem:NSTorage:CONNect',
		]);
		expect((result.warnings as string[]).some((warning) => warning.includes('clear text'))).toBeTruthy();
		assertSent(harness.fake, [
			':SYSTem:NSTorage "//10.12.255.239/nfs","","secret",0,0,1,0,0',
			':SYSTem:NSTorage:CONNect',
			':SYSTem:NSTorage?',
			':SYSTem:NSTorage:STATus?',
		]);
	});

	it('unmounts without touching the mount parameters', async () => {
		const result = payload(await call(harness, 'configure_network_storage', { connect: false }));
		expect(result.commands).toBeEqual([':SYSTem:NSTorage:DISConnect']);
		assertSent(harness.fake, [':SYSTem:NSTorage:DISConnect', ':SYSTem:NSTorage?', ':SYSTem:NSTorage:STATus?']);
	});

	it('sends nothing for a mount value that would break out of its quoted field', async () => {
		await assertInvalidSendsNothing(harness, 'configure_network_storage', {});
		await assertInvalidSendsNothing(harness, 'configure_network_storage', { path: '//srv/a";:SYSTem:REBoot' });
		await assertInvalidSendsNothing(harness, 'configure_network_storage', { path: '//srv/a', user: 'a,b' });
		await assertInvalidSendsNothing(harness, 'configure_network_storage', { path: '//srv/a', password: 'a;b' });
	});

	it('calibrates and reports the completion the guide documents', async () => {
		await assertInvalidSendsNothing(harness, 'calibrate_scope', {});
		const result = payload(await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true }));
		expect(result.calibrated).toBe(true);
		expect(result.commands).toBeEqual([':SYSTem:SELFCal']);
		expect((result.warnings as string[]).some((warning) => warning.includes('out of service'))).toBeTruthy();
		assertSent(harness.fake, [':SYSTem:SELFCal', ':SYSTem:SELFCal?']);
	});

	it('polls while the scope answers DOING and fails on anything else', async () => {
		let answered = 0;
		harness.fake.replies.set(':SYSTem:SELFCal?', (socket) => socket.write(`${answered++ === 0 ? 'DOING' : 'DONE'}\n`));
		const result = payload(await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true }));
		expect(result.calibrated).toBe(true);
		assertSent(harness.fake, [':SYSTem:SELFCal', ':SYSTem:SELFCal?', ':SYSTem:SELFCal?']);
		harness.fake.replies.set(':SYSTem:SELFCal?', 'FAILED');
		const refused = await call(harness, 'calibrate_scope', { confirm_inputs_disconnected: true });
		expect(refused.isError).toBe(true);
		harness.fake.replies.set(':SYSTem:SELFCal?', 'DONE');
		harness.fake.sent();
	});

	it('reboots and shuts down only with the acknowledgement', async () => {
		await assertInvalidSendsNothing(harness, 'reboot_scope', {});
		await assertInvalidSendsNothing(harness, 'shutdown_scope', { confirm_shutdown: false });
		const rebooted = payload(await call(harness, 'reboot_scope', { confirm_reboot: true }));
		expect(rebooted.commands).toBeEqual([':SYSTem:REBoot']);
		const off = payload(await call(harness, 'shutdown_scope', { confirm_shutdown: true }));
		expect(off.commands).toBeEqual([':SYSTem:SHUTdown']);
		assertSent(harness.fake, [':SYSTem:REBoot', ':SYSTem:SHUTdown']);
	});
});

// The shipped pino configuration is only proven by the process it configures: a subprocess runs the mount with
// LOG_LEVEL=info and its stderr is the captured pino destination.
describe('network-drive password redaction', () => {
	it('masks the password in the info log line and never logs it in clear text', () => {
		const script = `
			const { startScpiHarness } = await import(${JSON.stringify(new URL('../../../support/harness.ts', import.meta.url).href)});
			const harness = await startScpiHarness('SDS804X HD', {
				':SYSTem:NSTorage?': '"//srv/nfs","","***",0,0,0,0,0',
				':SYSTem:NSTorage:STATus?': 'ON',
			});
			const result = await harness.client.callTool({
				name: 'configure_network_storage',
				arguments: { path: '//srv/nfs', password: 'hunter2', connect: true },
			});
			process.stdout.write(JSON.stringify(result));
			await harness.close();
		`;
		const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
			encoding: 'utf8',
			env: { ...process.env, LOG_LEVEL: 'info' },
		});
		expect(run.status).toBe(0);
		expect(run.stderr).toMatchRegex(/"password":"\*\*\*"/);
		expect(!run.stderr.includes('hunter2')).toBeTruthy();
		const state = (JSON.parse(run.stdout).structuredContent as { state: { password: string } }).state;
		expect(state.password).toBe('***');
	});
});
