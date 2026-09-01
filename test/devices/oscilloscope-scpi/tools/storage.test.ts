import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type ScpiHarness, startScpiHarness } from '../../../support/harness.ts';

const call = (harness: ScpiHarness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const replies: Record<string, Reply> = {
	'*OPC?': '1',
	':MEMory2:HORizontal:POSition?': '1.00E-05',
	':MEMory2:HORizontal:SCALe?': '1.00E-07',
	':MEMory2:HORizontal:SYNC?': 'ON',
	':MEMory2:LABel?': 'ON',
	':MEMory2:LABel:TEXT?': '"MATH"',
	':MEMory2:SWITch?': 'ON',
	':MEMory2:VERTical:POSition?': '1.00E-01',
	':MEMory2:VERTical:SCALe?': '1.00E-01',
	':REFA:DATA:POSition?': '2.00E-01',
	':REFA:DATA:SCALe?': '1.00E-01',
	':REFA:DATA:SOURce?': 'C1',
	':REFA:LABel?': 'ON',
	':REFA:LABel:TEXT?': '"REFA"',
};

const warnings = (result: Record<string, unknown>): string[] => (result.warnings as string[]) ?? [];

describe('EN11F storage tools', () => {
	let harness: ScpiHarness;

	before(async () => {
		harness = await startScpiHarness('SDS804X HD', replies);
		await call(harness, 'identify');
		harness.fake.sent();
	});

	after(() => harness.close());

	it('reads one memory waveform and names the import as write-only', async () => {
		const state = payload(await call(harness, 'get_memory', { memory: 2, loaded: true }));
		expect(state).toBeEqual({
			memory: 2,
			horizontal_position: { value: 1e-5, raw: '1.00E-05' },
			horizontal_scale: { value: 1e-7, raw: '1.00E-07' },
			horizontal_sync: true,
			label: true,
			label_text: 'MATH',
			enabled: true,
			vertical_position: { value: 0.1, raw: '1.00E-01' },
			vertical_scale: { value: 0.1, raw: '1.00E-01' },
			write_only: [':MEMory<m>:IMPort'],
		});
		assertSent(harness.fake, [
			':MEMory2:SWITch?',
			':MEMory2:HORizontal:POSition?',
			':MEMory2:HORizontal:SCALe?',
			':MEMory2:HORizontal:SYNC?',
			':MEMory2:LABel?',
			':MEMory2:LABel:TEXT?',
			':MEMory2:VERTical:POSition?',
			':MEMory2:VERTical:SCALe?',
		]);
		await assertReadOnly(harness.client, 'get_memory');
	});

	it('refuses a memory read without the loaded assertion, before anything is sent', async () => {
		await assertInvalidSendsNothing(harness, 'get_memory', { memory: 2 });
	});

	it('keeps an unparseable memory scale as raw text instead of a number', async () => {
		harness.fake.replies.set(':MEMory2:VERTical:SCALe?', 'N/A');
		try {
			const state = payload(await call(harness, 'get_memory', { memory: 2, loaded: true }));
			expect(state.vertical_scale).toBeEqual({ raw: 'N/A' });
		} finally {
			harness.fake.replies.set(':MEMory2:VERTical:SCALe?', '1.00E-01');
			harness.fake.sent();
		}
	});

	it('writes memory settings in guide order and reads back only what it set', async () => {
		const result = payload(
			await call(harness, 'configure_memory', {
				memory: 2,
				loaded: true,
				enabled: true,
				vertical_scale: 0.1,
				label_text: 'MATH',
			}),
		);
		expect(result.commands).toBeEqual([
			':MEMory2:LABel:TEXT "MATH"',
			':MEMory2:SWITch ON',
			':MEMory2:VERTical:SCALe 1.00E-01',
		]);
		expect(result.warnings).toBe(undefined);
		assertSent(harness.fake, [
			':MEMory2:LABel:TEXT "MATH"',
			':MEMory2:SWITch ON',
			':MEMory2:VERTical:SCALe 1.00E-01',
			':MEMory2:LABel:TEXT?',
			':MEMory2:SWITch?',
			':MEMory2:VERTical:SCALe?',
		]);
	});

	it('writes without any read-back when loaded is not asserted, with a warning', async () => {
		const result = payload(await call(harness, 'configure_memory', { memory: 2, vertical_scale: 0.1 }));
		expect(result.commands).toBeEqual([':MEMory2:VERTical:SCALe 1.00E-01']);
		expect(result.state).toBeEqual({});
		expect(warnings(result).some((warning) => warning.includes('Nothing was read back'))).toBeTruthy();
		assertSent(harness.fake, [':MEMory2:VERTical:SCALe 1.00E-01']);
	});

	it('warns when the scope clamped a memory scale', async () => {
		const result = payload(await call(harness, 'configure_memory', { memory: 2, loaded: true, vertical_scale: 0.5 }));
		expect(warnings(result).some((warning) => warning.includes('vertical_scale'))).toBeTruthy();
		harness.fake.sent();
	});

	it('imports a trace and a file into a memory and waits for completion', async () => {
		const trace = payload(
			await call(harness, 'import_memory', { memory: 2, source: 'C1', confirm_overwrite_memory: true }),
		);
		expect(trace.commands).toBeEqual([':MEMory2:IMPort C1']);
		assertSent(harness.fake, [':MEMory2:IMPort C1', '*OPC?']);

		const file = payload(
			await call(harness, 'import_memory', {
				memory: 2,
				file: 'U-disk0/SIGLENT/test.bin',
				confirm_overwrite_memory: true,
			}),
		);
		expect(file.commands).toBeEqual([':MEMory2:IMPort "U-disk0/SIGLENT/test.bin"']);
		assertSent(harness.fake, [':MEMory2:IMPort "U-disk0/SIGLENT/test.bin"', '*OPC?']);
	});

	it('refuses a memory import the guide does not document, before anything is sent', async () => {
		await assertInvalidSendsNothing(harness, 'import_memory', { source: 'C1' });
		await assertInvalidSendsNothing(harness, 'import_memory', { confirm_overwrite_memory: true });
		await assertInvalidSendsNothing(harness, 'import_memory', {
			source: 'C1',
			file: 'local/a.bin',
			confirm_overwrite_memory: true,
		});
		await assertInvalidSendsNothing(harness, 'import_memory', { source: 'REFA', confirm_overwrite_memory: true });
		await assertInvalidSendsNothing(harness, 'import_memory', {
			memory: 5,
			source: 'C1',
			confirm_overwrite_memory: true,
		});
	});

	it('refuses a memory import path outside the documented shape', async () => {
		for (const file of [
			'local/SIGLENT/test.csv',
			'C:/SIGLENT/test.bin',
			'local/../test.bin',
			'local/te"st.bin',
			'local/test.bin";:AUToset',
			'local/te st.bin',
			'/SIGLENT/test.bin',
			'U-disk2/test.bin',
		]) {
			await assertInvalidSendsNothing(harness, 'import_memory', { file, confirm_overwrite_memory: true });
		}
	});

	it('refuses a channel the model does not have before anything is sent', async () => {
		const two = await startScpiHarness('SDS802X HD', replies);
		try {
			await call(two, 'identify');
			two.fake.sent();
			assertCapabilityError(
				await call(two, 'import_memory', { source: 'C3', confirm_overwrite_memory: true }),
				'SDS802X HD',
			);
			assertCapabilityError(
				await call(two, 'save_waveform_file', {
					format: 'BINary',
					path: 'local/SIGLENT/c3.bin',
					source: 'C3',
					confirm_overwrite: true,
				}),
				'SDS802X HD',
			);
			assertSent(two.fake, []);
		} finally {
			await two.close();
		}
	});

	it('reads one reference and names the data command as write-only', async () => {
		const state = payload(await call(harness, 'get_reference', { location: 'REFA' }));
		expect(state).toBeEqual({
			location: 'REFA',
			label: true,
			label_text: 'REFA',
			source: 'C1',
			vertical_scale: { value: 0.1, raw: '1.00E-01' },
			vertical_position: { value: 0.2, raw: '2.00E-01' },
			write_only: [':REF<r>:DATA'],
		});
		assertSent(harness.fake, [
			':REFA:LABel?',
			':REFA:LABel:TEXT?',
			':REFA:DATA:SOURce?',
			':REFA:DATA:SCALe?',
			':REFA:DATA:POSition?',
		]);
		await assertReadOnly(harness.client, 'get_reference');
	});

	it('saves a trace into a reference, displays it and reads the source back', async () => {
		const result = payload(
			await call(harness, 'configure_reference', {
				location: 'REFA',
				save_source: 'C1',
				display: true,
				vertical_scale: 0.1,
				confirm_overwrite_reference: true,
			}),
		);
		expect(result.commands).toBeEqual([':REFA:DATA SAVE,C1', ':REFA:DATA LOAD', ':REFA:DATA:SCALe 1.00E-01']);
		expect(result.state).toBeEqual({ vertical_scale: { value: 0.1, raw: '1.00E-01' }, source: 'C1' });
		assertSent(harness.fake, [
			':REFA:DATA SAVE,C1',
			':REFA:DATA LOAD',
			':REFA:DATA:SCALe 1.00E-01',
			':REFA:DATA:SCALe?',
			':REFA:DATA:SOURce?',
		]);
	});

	it('recalls a reference file before it displays the reference', async () => {
		const result = payload(
			await call(harness, 'configure_reference', {
				location: 'REFA',
				recall_file: 'U-disk0/SIGLENT/math.ref',
				display: true,
				confirm_overwrite_reference: true,
			}),
		);
		expect(result.commands).toBeEqual([':RECall:REFerence REFA,"U-disk0/SIGLENT/math.ref"', ':REFA:DATA LOAD']);
		harness.fake.sent();
	});

	it('warns that a scale without a display in the same request may not take', async () => {
		const result = payload(await call(harness, 'configure_reference', { location: 'REFA', vertical_position: 0.2 }));
		expect(warnings(result).some((warning) => warning.includes('saved and displayed'))).toBeTruthy();
		harness.fake.sent();
	});

	it('sends nothing for a reference request outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'configure_reference', {});
		await assertInvalidSendsNothing(harness, 'configure_reference', { save_source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_reference', {
			recall_file: 'local/SIGLENT/a.ref',
		});
		await assertInvalidSendsNothing(harness, 'configure_reference', {
			save_source: 'C1',
			recall_file: 'local/SIGLENT/a.ref',
			confirm_overwrite_reference: true,
		});
		await assertInvalidSendsNothing(harness, 'configure_reference', { display: false, vertical_scale: 0.1 });
		await assertInvalidSendsNothing(harness, 'configure_reference', { location: 'REFE', label: true });
		await assertInvalidSendsNothing(harness, 'configure_reference', {
			recall_file: 'U-disk0/SIGLENT/math.xml',
			confirm_overwrite_reference: true,
		});
		await assertInvalidSendsNothing(harness, 'configure_reference', { label_text: 'a,b' });
	});

	it('saves a setup to a slot, a file and the default settings', async () => {
		const slot = payload(await call(harness, 'save_panel_setup', { slot: 3, confirm_overwrite: true }));
		expect(slot.commands).toBeEqual([':SAVE:SETup INTernal,3']);
		assertSent(harness.fake, [':SAVE:SETup INTernal,3', '*OPC?']);

		const file = payload(
			await call(harness, 'save_panel_setup', { file: 'local/SIGLENT/default.xml', confirm_overwrite: true }),
		);
		expect(file.commands).toBeEqual([':SAVE:SETup EXTernal,"local/SIGLENT/default.xml"']);
		harness.fake.sent();

		const custom = payload(
			await call(harness, 'save_panel_setup', { default_setup: 'CUSTom', confirm_overwrite: true }),
		);
		expect(custom.commands).toBeEqual([':SAVE:DEFault CUSTom']);
		harness.fake.sent();
	});

	it('recalls a setup from a slot, a file and the factory settings', async () => {
		const slot = payload(await call(harness, 'recall_panel_setup', { slot: 3, confirm_recall: true }));
		expect(slot.commands).toBeEqual([':RECall:SETup INTernal,3']);
		assertSent(harness.fake, [':RECall:SETup INTernal,3', '*OPC?']);

		const file = payload(
			await call(harness, 'recall_panel_setup', { file: 'U-disk1/SIGLENT/default.xml', confirm_recall: true }),
		);
		expect(file.commands).toBeEqual([':RECall:SETup EXTernal,"U-disk1/SIGLENT/default.xml"']);
		harness.fake.sent();

		const factory = payload(await call(harness, 'recall_panel_setup', { factory: true, confirm_recall: true }));
		expect(factory.commands).toBeEqual([':RECall:FDEFault']);
		harness.fake.sent();
	});

	it('sends nothing for a setup request outside the guide', async () => {
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', { slot: 11, confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_panel_setup', {
			slot: 1,
			default_setup: 'CUSTom',
			confirm_overwrite: true,
		});
		await assertInvalidSendsNothing(harness, 'recall_panel_setup', { slot: 3 });
		await assertInvalidSendsNothing(harness, 'recall_panel_setup', { slot: 0, confirm_recall: true });
		await assertInvalidSendsNothing(harness, 'recall_panel_setup', {
			file: 'local/SIGLENT/default.set',
			confirm_recall: true,
		});
	});

	it('erases the internal storage and waits for completion', async () => {
		const result = payload(await call(harness, 'erase_internal_storage', { confirm_erase: true }));
		expect(result.commands).toBeEqual([':RECall:SERase']);
		assertSent(harness.fake, [':RECall:SERase', '*OPC?']);
		await assertInvalidSendsNothing(harness, 'erase_internal_storage', {});
	});

	it('saves waveform data in each documented format', async () => {
		const binary = payload(
			await call(harness, 'save_waveform_file', {
				format: 'BINary',
				path: 'U-disk0/SIGLENT/c1.bin',
				source: 'C1',
				confirm_overwrite: true,
			}),
		);
		expect(binary.commands).toBeEqual([':SAVE:BINary "U-disk0/SIGLENT/c1.bin",C1']);
		assertSent(harness.fake, [':SAVE:BINary "U-disk0/SIGLENT/c1.bin",C1', '*OPC?']);

		const csv = payload(
			await call(harness, 'save_waveform_file', {
				format: 'CSV',
				path: 'local/SIGLENT/c1.csv',
				source: 'DIGital',
				include_parameters: true,
				confirm_overwrite: true,
			}),
		);
		expect(csv.commands).toBeEqual([':SAVE:CSV "local/SIGLENT/c1.csv",DIGital,ON']);
		harness.fake.sent();

		const matlab = payload(
			await call(harness, 'save_waveform_file', {
				format: 'MATLab',
				path: 'net_storage/SIGLENT/c1.mat',
				source: 'C1',
				confirm_overwrite: true,
			}),
		);
		expect(matlab.commands).toBeEqual([':SAVE:MATLab "net_storage/SIGLENT/c1.mat",C1']);
		harness.fake.sent();

		const reference = payload(
			await call(harness, 'save_waveform_file', {
				format: 'REFerence',
				path: 'local/SIGLENT/c1.ref',
				source: 'D0',
				confirm_overwrite: true,
			}),
		);
		expect(reference.commands).toBeEqual([':SAVE:REFerence "local/SIGLENT/c1.ref",D0']);
		harness.fake.sent();
	});

	it('sends nothing for a waveform file the guide does not document', async () => {
		const base = { format: 'BINary', path: 'local/SIGLENT/c1.bin', source: 'C1' };
		await assertInvalidSendsNothing(harness, 'save_waveform_file', base);
		await assertInvalidSendsNothing(harness, 'save_waveform_file', {
			...base,
			confirm_overwrite: true,
			path: 'local/SIGLENT/c1.csv',
		});
		await assertInvalidSendsNothing(harness, 'save_waveform_file', {
			format: 'BINary',
			path: 'local/SIGLENT/c1.bin',
			source: 'DIGital',
			confirm_overwrite: true,
		});
		await assertInvalidSendsNothing(harness, 'save_waveform_file', {
			format: 'REFerence',
			path: 'local/SIGLENT/c1.ref',
			source: 'M1',
			confirm_overwrite: true,
		});
		await assertInvalidSendsNothing(harness, 'save_waveform_file', {
			...base,
			include_parameters: true,
			confirm_overwrite: true,
		});
		await assertInvalidSendsNothing(harness, 'save_waveform_file', {
			...base,
			path: 'local/SIGLENT/c1.bin',
			confirm_overwrite: true,
			format: 'BMP',
		});
	});

	it('takes the image format from the file extension', async () => {
		for (const [path, type] of [
			['U-disk0/SIGLENT/screen.bmp', 'BMP'],
			['local/screen.jpg', 'JPG'],
			['net_storage/screen.png', 'PNG'],
		]) {
			const result = payload(await call(harness, 'save_screenshot', { path, confirm_overwrite: true }));
			expect(result.commands).toBeEqual([`:SAVE:IMAGe "${path}",${type},OFF`]);
			harness.fake.sent();
		}
		const inverted = payload(
			await call(harness, 'save_screenshot', {
				path: 'local/screen.png',
				inverted: true,
				confirm_overwrite: true,
			}),
		);
		expect(inverted.commands).toBeEqual([':SAVE:IMAGe "local/screen.png",PNG,ON']);
		harness.fake.sent();
	});

	it('sends nothing for a screenshot path the guide does not document', async () => {
		await assertInvalidSendsNothing(harness, 'save_screenshot', { path: 'local/screen.png' });
		await assertInvalidSendsNothing(harness, 'save_screenshot', { path: 'local/screen.gif', confirm_overwrite: true });
		await assertInvalidSendsNothing(harness, 'save_screenshot', {
			path: 'local/screen.png',
			invert: true,
			confirm_overwrite: true,
		});
	});

	it('declares every storage write destructive', async () => {
		const { tools } = await harness.client.listTools();
		for (const name of [
			'import_memory',
			'configure_reference',
			'save_panel_setup',
			'recall_panel_setup',
			'erase_internal_storage',
			'save_waveform_file',
			'save_screenshot',
		]) {
			const found = tools.find((entry) => entry.name === name);
			expect(found?.annotations?.destructiveHint).toBe(true);
		}
		expect(tools.find((entry) => entry.name === 'configure_memory')?.annotations?.destructiveHint).toBe(false);
	});
});
