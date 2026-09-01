import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { selectDriver } from '../../../src/devices/index.ts';
import { oscilloscope } from '../../../src/devices/oscilloscope/driver.ts';
import { oscilloscopeScpi } from '../../../src/devices/oscilloscope-scpi/driver.ts';
import { describeModel, older, probesResolution } from '../../../src/devices/oscilloscope-scpi/models.ts';
import type { ScpiScope } from '../../../src/devices/oscilloscope-scpi/scope.ts';
import { payload } from '../../support/assertions.ts';
import { startScpiHarness } from '../../support/harness.ts';

describe('driver routing', () => {
	const newer = ['SDS804X HD', 'SDS2354X HD', 'SDS2104X Plus', 'SDS5104X', 'SDS6204 Pro', 'SHS810X', 'SHS1102X'];
	for (const model of newer) {
		it(`${model} gets the EN11F driver`, () => {
			expect(selectDriver(model)).toBe(oscilloscopeScpi);
		});
	}

	const legacy = ['SDS1104X-E', 'SDS1204X-C', 'SDS1102X', 'SDS2104X', 'SDS1102CML+'];
	for (const model of legacy) {
		it(`${model} keeps the PG01-E02C driver`, () => {
			expect(selectDriver(model)).toBe(oscilloscope);
		});
	}

	// An SDS model no family table lists has an unknown dialect, so it stays with the legacy driver and its warning
	// rather than being promised a command set nothing documents for it.
	it('leaves an unrecognized SDS model with the legacy driver', () => {
		expect(selectDriver('SDS9999')).toBe(oscilloscope);
	});

	it('serves the EN11F tool set and no PG01-E02C tool', () => {
		const names = oscilloscopeScpi.tools.map(({ name }) => name);
		expect(names.toSorted()).toBeEqual([
			'autoset_fft',
			'autoset_scope',
			'calibrate_scope',
			'capture_screenshot',
			'clear_display',
			'clear_measurements',
			'clear_sweeps',
			'configure_acquisition',
			'configure_advanced_measurement',
			'configure_channel',
			'configure_counter',
			'configure_cursors',
			'configure_data_format',
			'configure_decode',
			'configure_digital',
			'configure_display',
			'configure_dvm',
			'configure_fft',
			'configure_history',
			'configure_lan',
			'configure_mask_test',
			'configure_math',
			'configure_measurement_gate',
			'configure_measurement_setup',
			'configure_measurement_statistics',
			'configure_memory',
			'configure_meter',
			'configure_network_storage',
			'configure_reference',
			'configure_search',
			'configure_system_settings',
			'configure_timebase',
			'configure_trigger',
			'configure_trigger_mode',
			'configure_waveform_generator',
			'copy_decode_settings',
			'copy_search_settings',
			'create_mask',
			'erase_internal_storage',
			'get_acquisition',
			'get_channel',
			'get_counter',
			'get_cursors',
			'get_data_format',
			'get_decode',
			'get_digital',
			'get_display',
			'get_dvm_reading',
			'get_fft',
			'get_history',
			'get_lan_configuration',
			'get_mask_test',
			'get_math',
			'get_measurement_gate',
			'get_measurement_setup',
			'get_measurement_statistics',
			'get_memory',
			'get_network_storage',
			'get_reference',
			'get_search',
			'get_system_settings',
			'get_timebase',
			'get_trigger',
			'get_waveform',
			'get_waveform_generator',
			'identify',
			'import_memory',
			'list_measurements',
			'load_mask',
			'measure',
			'measure_cursors',
			'measure_delay',
			'measure_meter',
			'read_decode_result',
			'read_fft_peaks',
			'read_mask_test_result',
			'read_measurement',
			'read_meter',
			'read_search_events',
			'reboot_scope',
			'recall_panel_setup',
			'reset_counter',
			'reset_fft',
			'reset_mask_test',
			'reset_scope',
			'save_panel_setup',
			'save_screenshot',
			'save_waveform_file',
			'scpi_command',
			'scpi_query',
			'shutdown_scope',
			'wait_until_complete',
		]);
		expect(names.includes('configure_communication_header')).toBe(false);
		expect(names.includes('mark_operation_complete')).toBe(false);
	});
});

describe('model facts', () => {
	it('reads the firmware floor out of the guide Supported Models table', () => {
		expect(describeModel('SDS804X HD').firmware).toBe('1.1.3.1');
		expect(describeModel('SDS2104X Plus').firmware).toBe('1.3.5R3');
		expect(describeModel('SHS810X').firmware).toBe('1.1.9');
		expect(describeModel('SDS9999').firmware).toBe(undefined);
	});

	it('compares firmware numerically, field by field', () => {
		expect(older('1.1.3.0', '1.1.3.1')).toBe(true);
		expect(older('1.10.0.0', '1.9.0.0')).toBe(false);
		expect(older('1.1.3.1', '1.1.3.1')).toBe(false);
		expect(older('2.0.0.0', '1.1.3.1')).toBe(false);
	});

	// The guide documents :ACQuire:RESolution for the SDS2000X Plus and no other model (p. 43); asking anywhere else
	// is the hang class this driver exists to avoid.
	it('probes the ADC resolution only where the guide documents the query', () => {
		expect(probesResolution('SDS2104X Plus')).toBe(true);
		expect(probesResolution('SDS804X HD')).toBe(false);
	});

	it('seeds a known sample resolution from family metadata', () => {
		expect(describeModel('SDS804X HD').resolution).toBeEqual({ bits: 12 });
	});
});

describe('handshake', () => {
	it('sends nothing but *IDN? and derives the capabilities', async () => {
		const harness = await startScpiHarness('SDS804X HD');
		try {
			const identity = payload(await harness.client.callTool({ name: 'identify', arguments: {} }));
			expect(identity.model).toBe('SDS804X HD');
			expect(harness.fake.sent()).toBeEqual(['*IDN?', '*IDN?']);
			expect(identity.capabilities).toBeEqual({
				family: 'SDS X HD',
				channels: 4,
				firmware: '1.1.3.1',
				resolution: { bits: 12 },
			});
		} finally {
			await harness.close();
		}
	});

	it('reads the ADC resolution on the one family the guide documents it for', async () => {
		const harness = await startScpiHarness('SDS2104X Plus', { ':ACQuire:RESolution?': '10Bits' });
		try {
			const identity = payload(await harness.client.callTool({ name: 'identify', arguments: {} }));
			expect(harness.fake.sent()).toBeEqual(['*IDN?', ':ACQuire:RESolution?', '*IDN?', ':ACQuire:RESolution?']);
			expect((identity.capabilities as { resolution: unknown }).resolution).toBeEqual({ bits: 10 });
		} finally {
			await harness.close();
		}
	});

	it('warns about firmware older than the supported version, and still serves the tools', async () => {
		const harness = await startScpiHarness('SDS804X HD');
		harness.fake.replies.set('*IDN?', 'Siglent Technologies,SDS804X HD,SDS08A0000001,1.1.2.9');
		try {
			const identity = payload(await harness.client.callTool({ name: 'identify', arguments: {} }));
			expect(identity.firmware).toBe('1.1.2.9');
			expect(String((identity.warnings as string[])[0])).toMatchRegex(/firmware 1\.1\.2\.9.*supported 1\.1\.3\.1/);
		} finally {
			await harness.close();
		}
	});

	// The SHS800X names end in 0 and the guide states no channel count, so nothing is claimed and nothing is gated.
	it('warns that an SHS810X states no channel count and refuses no channel', async () => {
		const harness = await startScpiHarness('SHS810X', { ':DVM:SOURce?': 'C4' });
		try {
			const identity = payload(await harness.client.callTool({ name: 'identify', arguments: {} }));
			expect((identity.capabilities as { channels?: number }).channels).toBe(undefined);
			expect((identity.warnings as string[]).some((warning) => warning.includes('channel count'))).toBeTruthy();
			const result = await harness.client.callTool({ name: 'configure_dvm', arguments: { source: 'C4' } });
			expect(result.isError).not.toBe(true);
			expect(harness.fake.sent().includes(':DVM:SOURce C4')).toBeTruthy();
		} finally {
			await harness.close();
		}
	});

	it('describes the instrument for the startup banner', async () => {
		const harness = await startScpiHarness('SDS804X HD');
		try {
			await harness.client.callTool({ name: 'identify', arguments: {} });
			const { facts, warnings } = oscilloscopeScpi.describe(harness.scope as ScpiScope);
			expect(facts).toBeEqual(['SDS X HD', '4 channels', '12-bit', 'firmware 1.2.2.1']);
			expect(warnings).toBeEqual([]);
		} finally {
			await harness.close();
		}
	});

	it('reports the remote lock state at startup and warns while it is on', async () => {
		const harness = await startScpiHarness('SDS804X HD', { ':SYSTem:REMote?': 'ON' });
		try {
			await oscilloscopeScpi.prepare?.(harness.scope, { unlock: false, allowLock: false });
			expect(harness.fake.sent()).toBeEqual(['*IDN?', ':SYSTem:REMote?']);
			const { facts, warnings } = oscilloscopeScpi.describe(harness.scope);
			expect(facts.includes('remote lock on')).toBeTruthy();
			expect(String(warnings[0])).toMatchRegex(/locked by remote control.*--unlock/);
		} finally {
			await harness.close();
		}
	});

	it('clears the remote lock on connect when asked, and only while it is on', async () => {
		const harness = await startScpiHarness('SDS804X HD');
		const answers = ['ON', 'OFF'];
		harness.fake.replies.set(':SYSTem:REMote?', (socket) => socket.write(`${answers.shift() ?? 'OFF'}\n`));
		try {
			await oscilloscopeScpi.prepare?.(harness.scope, { unlock: true, allowLock: false });
			expect(harness.fake.sent()).toBeEqual(['*IDN?', ':SYSTem:REMote?', ':SYSTem:REMote OFF', ':SYSTem:REMote?']);
			const { facts, warnings } = oscilloscopeScpi.describe(harness.scope);
			expect(facts.includes('remote lock off')).toBeTruthy();
			expect(warnings).toBeEqual([]);

			await oscilloscopeScpi.prepare?.(harness.scope, { unlock: true, allowLock: false });
			expect(harness.fake.sent()).toBeEqual([':SYSTem:REMote?']);
		} finally {
			await harness.close();
		}
	});

	it('carries the enable-lock intent onto the scope', async () => {
		const harness = await startScpiHarness('SDS804X HD', { ':SYSTem:REMote?': 'OFF' });
		try {
			expect(harness.scope.allowLock).toBe(false);
			await oscilloscopeScpi.prepare?.(harness.scope, { unlock: false, allowLock: true });
			expect(harness.scope.allowLock).toBe(true);
		} finally {
			await harness.close();
		}
	});
});
