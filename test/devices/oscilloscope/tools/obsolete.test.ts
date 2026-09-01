import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import { type Harness, startHarness } from '../../../support/harness.ts';

const identity = (model: string) => ({ '*IDN?': `Siglent Technologies,${model},SDS1EBAC0L0001,5.1.0` });

const replies = {
	'ACAL?': 'OFF',
	'AUTTS?': 'MP',
	'COUN?': 'ON',
	'CSVS?': 'CSV_SAVE DD,MAX,SAVE,ON',
	'DATE?': 'DATE 1,NOV,2017,14,38,16',
	'PFCT?': 'PF_CONTROL TRACE,C1,CONTROL,START,OUTPUT,PASS,OUTPUTSTOP,OFF',
	'REFS? REF,RA': 'REF_SET REF,RA,STATE,ON',
	'FFTZ?': 'FFT_ZOOM 2',
	'PDET?': 'OFF',
	'PERS?': 'ON',
	'C1:FILT?': 'C1:FILTER ON',
	'C1:FILTS?': 'C1:FILTER TYPE,BP,UPPLIMIT,2.0E+5,LOWLIMIT,1.0E+5',
	'TA:VPOS?': 'TA:VERT_POSITION 3V',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const clamped = (result: Record<string, unknown>): boolean =>
	((result.warnings ?? []) as string[]).some((warning) => warning.includes('the scope reports'));

const send = (harness: Harness, args: Record<string, unknown>) =>
	call(harness, 'send_obsolete_command', { confirm_obsolete: true, ...args });

// CSVS answers in the format its own series takes (p. 290): DD,<depth>,SAVE,<state> on the three oldest series,
// SAVE,<state> on the SDS1000X and SDS2000X.
const csvSave = (model: string): string =>
	/^SDS1\d{3}(CFL|A|(CML|CNL|DL|E|F)\+)$/.test(model) ? 'CSV_SAVE DD,MAX,SAVE,ON' : 'CSV_SAVE SAVE,OFF';

async function withModel(model: string, work: (harness: Harness) => Promise<void>): Promise<void> {
	const harness = await startHarness({ ...replies, 'CSVS?': csvSave(model), ...identity(model) });
	try {
		await call(harness, 'identify');
		harness.fake.sent();
		await work(harness);
	} finally {
		await harness.close();
	}
}

interface Listing {
	series: string;
	inventory: Array<{
		command: string;
		support: string;
		values?: unknown;
		write_only?: string[];
		target?: string;
		instead: string;
		equivalent: string;
	}>;
}

describe('obsolete compatibility', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness({ ...replies, ...identity('SDS1102CFL') });
		await call(harness, 'identify');
	});

	after(() => harness.close());

	it('annotates the reader read-only and the sender destructive', async () => {
		await assertReadOnly(harness.client, 'get_obsolete_settings');
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'send_obsolete_command')?.annotations;
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(true);
	});

	it('keeps the obsolete commands off the modern tool surface', async () => {
		const { tools } = await harness.client.listTools();
		const obsolete = tools.filter(({ name }) => name.includes('obsolete'));
		expect(obsolete.map(({ name }) => name).sort()).toBeEqual(['get_obsolete_settings', 'send_obsolete_command']);
	});

	it('lists every obsolete command with its equivalent and queries only the ones with a query form', async () => {
		harness.fake.sent();
		const listing = payload(await call(harness, 'get_obsolete_settings')) as unknown as Listing;
		expect(listing.series).toBe('SDS1000CFL');
		expect(listing.inventory.map(({ command, support }) => [command, support])).toBeEqual([
			['ACAL', 'supported'],
			['AUTTS', 'supported'],
			['COUN', 'supported'],
			['CRAU', 'supported'],
			['CSVS', 'supported'],
			['DATE', 'supported'],
			['FFTZ', 'supported'],
			['FILT', 'supported'],
			['FILTS', 'supported'],
			['PDET', 'supported'],
			['PFCT', 'supported'],
			['PERS', 'supported'],
			['REC', 'supported'],
			['REFS', 'supported'],
			['VPOS', 'supported'],
		]);
		const listed = Object.fromEntries(listing.inventory.map((entry) => [entry.command, entry]));
		const values = Object.fromEntries(listing.inventory.map(({ command, values: value }) => [command, value]));
		expect(values.ACAL).toBeEqual({ quick_calibration: 'OFF' });
		expect(values.AUTTS).toBeEqual({ autoset_type: 'MP' });
		expect(values.CRAU).toBe(undefined);
		expect(listed.CRAU?.write_only).toBeEqual(['CRAU']);
		expect(values.REC).toBe(undefined);
		expect(listed.REC?.write_only).toBeEqual(['REC']);
		expect(values.FFTZ).toBeEqual({ fft_zoom: { value: 2, raw: 'FFT_ZOOM 2' } });
		expect(values.CSVS).toBeEqual({ data_depth: 'MAX', save_parameters: 'ON' });
		expect(values.DATE).toBeEqual({
			day: { value: 1, raw: '1' },
			month: 'NOV',
			year: { value: 2017, raw: '2017' },
			hour: { value: 14, raw: '14' },
			minute: { value: 38, raw: '38' },
			second: { value: 16, raw: '16' },
		});
		expect(values.PFCT).toBeEqual({ source: 'C1', operate: 'START', output: 'PASS', stop_on_output: 'OFF' });
		expect([values.FILT, values.FILTS, values.VPOS, values.REFS]).toBeEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect([listed.FILT?.target, listed.FILTS?.target, listed.VPOS?.target, listed.REFS?.target]).toBeEqual([
			'channel',
			'channel',
			'trace',
			'reference',
		]);
		expect(listed.REFS?.target).toBe('reference');
		expect(listed.REC?.target).toBe('memory');
		expect(listed.CRAU?.equivalent).toBe('none (p. 283)');
		expect(listed.PFCT?.equivalent).toBe('PFSC, PFBF, PFOP, PFFS (p. 283), one command split into four');
		expect(listed.REFS?.equivalent).toBe('REFSR, REFLA, REFDS, REFSA (p. 283), one command split into four');
		expect(listed.ACAL?.instead ?? '').toMatchRegex(/calibrate_scope/);
		expect(listed.PDET?.instead ?? '').toMatchRegex(/configure_acquisition/);
		expect(listed.VPOS?.instead ?? '').toMatchRegex(/configure_fft/);
		expect(listed.REC?.instead ?? '').toMatchRegex(/recall_panel_setup/);
		expect(listed.REFS?.instead ?? '').toMatchRegex(/configure_reference/);
		expect(listed.PFCT?.instead ?? '').toMatchRegex(/configure_pass_fail/);
		assertSent(harness.fake, ['ACAL?', 'AUTTS?', 'COUN?', 'CSVS?', 'DATE?', 'FFTZ?', 'PDET?', 'PFCT?', 'PERS?']);
	});

	it('sends a command-only mnemonic without querying it back', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'CRAU' }));
		expect(result.commands).toBeEqual(['CRAU']);
		expect(result.values).toBe(undefined);
		expect(result.write_only).toBeEqual(['CRAU']);
		assertSent(harness.fake, ['CRAU']);
	});

	it('sends a command and reads it back', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'COUN', counter_display: true }));
		expect(result.commands).toBeEqual(['COUN ON']);
		expect(result.values).toBeEqual({ counter_display: 'ON' });
		expect(result.warnings).toBeEqual(['Support for obsolete commands on SDS1102CFL (SDS1000 non-SPO) is unknown']);
		assertSent(harness.fake, ['COUN ON', 'COUN?']);
	});

	it('prefixes a command the guide addresses per channel and reads it back at that channel', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'FILT', channel: 'C1', filter_enabled: true }));
		expect(result.commands).toBeEqual(['C1:FILT ON']);
		expect(result.values).toBeEqual({ filter_enabled: 'ON' });
		assertSent(harness.fake, ['C1:FILT ON', 'C1:FILT?']);
	});

	it('sends a composite command as one line of pairs and parses the one answer back', async () => {
		harness.fake.sent();
		const result = payload(
			await send(harness, {
				command: 'FILTS',
				channel: 'C1',
				filter_type: 'BP',
				upper_limit: '200KHz',
				lower_limit: '100KHz',
			}),
		);
		expect(result.commands).toBeEqual(['C1:FILTS TYPE,BP,UPPLIMIT,200KHz,LOWLIMIT,100KHz']);
		expect(result.values).toBeEqual({
			filter_type: 'BP',
			upper_limit: { value: 200000, raw: '2.0E+5' },
			lower_limit: { value: 100000, raw: '1.0E+5' },
		});
		expect(!(result.warnings as string[]).some((warning) => /limit/.test(warning))).toBeTruthy();
		assertSent(harness.fake, ['C1:FILTS TYPE,BP,UPPLIMIT,200KHz,LOWLIMIT,100KHz', 'C1:FILTS?']);
	});

	it('moves an FFT trace by name and keeps VPOS distinct from FFTP', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'VPOS', trace: 'TA', vertical_position: '3V' }));
		expect(result.commands).toBeEqual(['TA:VPOS 3V']);
		expect(result.values).toBeEqual({ vertical_position: { value: 3, unit: 'V', raw: 'TA:VERT_POSITION 3V' } });
		expect(result.instead as string).toMatchRegex(/configure_fft/);
		assertSent(harness.fake, ['TA:VPOS 3V', 'TA:VPOS?']);
	});

	it('sends the CSVS line of the three oldest series, which names the data depth', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'CSVS', data_depth: 'MAX', save_parameters: true }));
		expect(result.commands).toBeEqual(['CSVS DD,MAX,SAVE,ON']);
		expect(result.values).toBeEqual({ data_depth: 'MAX', save_parameters: 'ON' });
		expect(!clamped(result)).toBeTruthy();
		assertSent(harness.fake, ['CSVS DD,MAX,SAVE,ON', 'CSVS?']);
	});

	it('sets the clock as one positional list and reads the whole date back', async () => {
		harness.fake.sent();
		const result = payload(
			await send(harness, {
				command: 'DATE',
				day: 1,
				month: 'NOV',
				year: 2017,
				hour: 14,
				minute: 38,
				second: 16,
			}),
		);
		expect(result.commands).toBeEqual(['DATE 1,NOV,2017,14,38,16']);
		expect(result.values).toBeEqual({
			day: { value: 1, raw: '1' },
			month: 'NOV',
			year: { value: 2017, raw: '2017' },
			hour: { value: 14, raw: '14' },
			minute: { value: 38, raw: '38' },
			second: { value: 16, raw: '16' },
		});
		assertSent(harness.fake, ['DATE 1,NOV,2017,14,38,16', 'DATE?']);
	});

	it('refuses a day its month does not have, and a value outside the range of the guide', async () => {
		const date = { command: 'DATE', month: 'FEB', year: 2017, hour: 14, minute: 38, second: 16 };
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			...date,
			day: 29,
		});
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			...date,
			day: 1,
			year: 1989,
		});
		const leap = payload(await send(harness, { ...date, day: 29, year: 2016 }));
		expect(leap.commands).toBeEqual(['DATE 29,FEB,2016,14,38,16']);
	});

	it('drives the pass/fail test of the older series as one line and reads its four fields back', async () => {
		harness.fake.sent();
		const result = payload(
			await send(harness, {
				command: 'PFCT',
				source: 'C1',
				operate: 'START',
				output: 'PASS',
				stop_on_output: false,
			}),
		);
		expect(result.commands).toBeEqual(['PFCT TRACE,C1,CONTROL,START,OUTPUT,PASS,OUTPUTSTOP,OFF']);
		expect(result.values).toBeEqual({ source: 'C1', operate: 'START', output: 'PASS', stop_on_output: 'OFF' });
		assertSent(harness.fake, ['PFCT TRACE,C1,CONTROL,START,OUTPUT,PASS,OUTPUTSTOP,OFF', 'PFCT?']);
	});

	it('recalls a waveform file into a memory of the CFL series without querying it back', async () => {
		harness.fake.sent();
		const result = payload(
			await send(harness, {
				command: 'REC',
				memory: 'M20',
				device: 'UDSK',
				file: { file: 'C1WF', directory: ['WAVE'] },
			}),
		);
		expect(result.commands).toBeEqual(["M20:REC DISK,UDSK,FILE,'/WAVE/C1WF.DAV'"]);
		expect(result.values).toBe(undefined);
		expect(result.write_only).toBeEqual(['REC']);
		assertSent(harness.fake, ["M20:REC DISK,UDSK,FILE,'/WAVE/C1WF.DAV'"]);
	});

	it('keeps a file name out of the command grammar', async () => {
		for (const file of ['C1WF.DAV', 'C1/WF', "C1',X", 'TOOLONGNAME']) {
			await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
				confirm_obsolete: true,
				command: 'REC',
				memory: 'M1',
				device: 'UDSK',
				file: { file },
			});
		}
	});

	it('sets a reference waveform in one line and asks the query for the reference it named', async () => {
		harness.fake.sent();
		const saved = payload(
			await send(harness, {
				command: 'REFS',
				reference_source: 'C1',
				reference: 'RA',
				display: true,
				save_to_reference: true,
			}),
		);
		expect(saved.commands).toBeEqual(['REFS TRACE,C1,REF,RA,STATE,ON,SAVE,DO']);
		expect(saved.values).toBeEqual({ reference: 'RA', display: 'ON' });
		assertSent(harness.fake, ['REFS TRACE,C1,REF,RA,STATE,ON,SAVE,DO', 'REFS? REF,RA']);

		const shown = payload(
			await send(harness, { command: 'REFS', reference_source: 'C1', reference: 'RA', display: true }),
		);
		expect(shown.commands).toBeEqual(['REFS TRACE,C1,REF,RA,STATE,ON']);
	});

	it('refuses a limit the filter type does not take, and a channel the model does not have', async () => {
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			command: 'FILTS',
			channel: 'C1',
			filter_type: 'LP',
			lower_limit: '100KHz',
		});
		harness.fake.sent();
		const refused = assertCapabilityError(
			await send(harness, { command: 'FILT', channel: 'C4', filter_enabled: true }),
			'SDS1102CFL',
		);
		expect(refused.error).toMatchRegex(/has 2 channels.*Choose an available channel instead of C4/);
		assertSent(harness.fake, []);
	});

	it('warns when the scope did not take the value', async () => {
		harness.fake.sent();
		const result = payload(await send(harness, { command: 'ACAL', quick_calibration: true }));
		expect(result.commands).toBeEqual(['ACAL ON']);
		expect(
			(result.warnings as string[]).some((warning) => /quick_calibration was set to true/.test(warning)),
		).toBeTruthy();
	});

	it('rejects a request without confirmation, with a foreign field, without its own, or misspelled', async () => {
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', { command: 'CRAU' });
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			command: 'ACAL',
			autoset_type: 'MP',
		});
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', { confirm_obsolete: true, command: 'ACAL' });
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			command: 'AUTTS',
			autoset_type: 'XX',
		});
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', {
			confirm_obsolete: true,
			command: 'AUTTS',
			autoset_type: 'MP',
			quick_calibrations: true,
		});
		await assertInvalidSendsNothing(harness, 'send_obsolete_command', { confirm_obsolete: true, command: 'FFTZ' });
	});
});

describe('obsolete availability per model series', () => {
	it('refuses every obsolete command on SDS1000X-E without writing', async () => {
		await withModel('SDS1104X-E', async (harness) => {
			assertCapabilityError(await call(harness, 'get_obsolete_settings'), 'SDS1104X-E');
			assertCapabilityError(await send(harness, { command: 'CRAU' }), 'SDS1104X-E');
			assertSent(harness.fake, []);
		});
	});

	it('rejects COUN and CRAU on SDS2000X and still sends ACAL and AUTTS', async () => {
		await withModel('SDS2104X', async (harness) => {
			const listing = payload(await call(harness, 'get_obsolete_settings')) as unknown as Listing;
			expect(listing.inventory.map(({ command, support }) => [command, support])).toBeEqual([
				['ACAL', 'supported'],
				['AUTTS', 'supported'],
				['COUN', 'unsupported'],
				['CRAU', 'unsupported'],
				['CSVS', 'supported'],
				['DATE', 'supported'],
				['FFTZ', 'supported'],
				['FILT', 'unsupported'],
				['FILTS', 'unsupported'],
				['PDET', 'supported'],
				['PFCT', 'supported'],
				['PERS', 'supported'],
				['REC', 'supported'],
				['REFS', 'supported'],
				['VPOS', 'supported'],
			]);
			expect(listing.inventory.at(2)?.values).toBe(undefined);
			assertSent(harness.fake, ['ACAL?', 'AUTTS?', 'CSVS?', 'DATE?', 'FFTZ?', 'PDET?', 'PFCT?', 'PERS?']);

			const refused = assertCapabilityError(
				await send(harness, { command: 'COUN', counter_display: true }),
				'SDS2104X',
			);
			expect(refused.error).toMatchRegex(/does not support the obsolete COUN command/);
			assertSent(harness.fake, []);

			expect(payload(await send(harness, { command: 'AUTTS', autoset_type: 'MP' })).commands).toBeEqual(['AUTTS MP']);
		});
	});

	it('sends the shorter CSVS line on SDS2000X and refuses the data depth the older format names', async () => {
		await withModel('SDS2104X', async (harness) => {
			const result = payload(await send(harness, { command: 'CSVS', save_parameters: false }));
			expect(result.commands).toBeEqual(['CSVS SAVE,OFF']);
			expect(result.values).toBeEqual({ save_parameters: 'OFF' });
			expect(!clamped(result)).toBeTruthy();
			assertSent(harness.fake, ['CSVS SAVE,OFF', 'CSVS?']);

			const refused = assertCapabilityError(
				await send(harness, { command: 'CSVS', data_depth: 'MAX', save_parameters: false }),
				'SDS2104X',
			);
			expect(refused.error).toMatchRegex(
				/the CSVS line of SDS2000X has no data_depth.*Choose a command supported by this model/,
			);
			assertSent(harness.fake, []);
		});
	});

	it('refuses the memories only the CFL series reaches, and DATE where the table says no', async () => {
		await withModel('SDS2104X', async (harness) => {
			const file = { file: 'C1WF' };
			const refused = assertCapabilityError(
				await send(harness, { command: 'REC', memory: 'M11', device: 'UDSK', file }),
				'SDS2104X',
			);
			expect(refused.error).toMatchRegex(/memory M11 belongs to SDS1000CFL.*Choose a command supported by this model/);
			assertSent(harness.fake, []);
			const result = payload(await send(harness, { command: 'REC', memory: 'M10', device: 'UDSK', file }));
			expect(result.commands).toBeEqual(["M10:REC DISK,UDSK,FILE,'C1WF.DAV'"]);
		});
		await withModel('SDS1052A', async (harness) => {
			const refused = assertCapabilityError(
				await send(harness, { command: 'DATE', day: 1, month: 'NOV', year: 2017, hour: 14, minute: 38, second: 16 }),
				'SDS1052A',
			);
			expect(refused.error).toMatchRegex(/does not support the obsolete DATE command/);
			assertSent(harness.fake, []);
		});
	});

	it('rejects ACAL on SDS1000A and on the CML+ group, which take the other three', async () => {
		await withModel('SDS1052A', async (harness) => {
			assertCapabilityError(await send(harness, { command: 'ACAL', quick_calibration: false }), 'SDS1052A');
			assertSent(harness.fake, []);
			expect(payload(await send(harness, { command: 'CRAU' })).commands).toBeEqual(['CRAU']);
		});
		await withModel('SDS1102CML+', async (harness) => {
			assertCapabilityError(await send(harness, { command: 'ACAL', quick_calibration: false }), 'SDS1102CML\\+');
			assertSent(harness.fake, []);
			expect(payload(await send(harness, { command: 'COUN', counter_display: true })).commands).toBeEqual(['COUN ON']);
		});
	});

	it('rejects everything but AUTTS on SDS1000X', async () => {
		await withModel('SDS1202X', async (harness) => {
			const listing = payload(await call(harness, 'get_obsolete_settings')) as unknown as Listing;
			expect(
				listing.inventory.filter(({ support }) => support === 'supported').map(({ command }) => command),
			).toBeEqual(['AUTTS', 'CSVS', 'FFTZ', 'PDET', 'PFCT', 'PERS', 'REC', 'REFS', 'VPOS']);
			assertSent(harness.fake, ['AUTTS?', 'CSVS?', 'FFTZ?', 'PDET?', 'PFCT?', 'PERS?']);
			assertCapabilityError(await send(harness, { command: 'ACAL', quick_calibration: true }), 'SDS1202X');
		});
	});

	it('reports unknown support for a model the availability tables do not list, and still sends', async () => {
		await withModel('SDS9999Z', async (harness) => {
			const listing = payload(await call(harness, 'get_obsolete_settings')) as unknown as Listing;
			expect(listing.series).toBe('not listed in the obsolete availability tables');
			expect(new Set(listing.inventory.map(({ support }) => support))).toBeEqual(new Set(['unknown']));
			assertSent(harness.fake, []);

			const result = payload(await send(harness, { command: 'COUN', counter_display: true }));
			expect(result.support).toBe('unknown');
			expect(result.commands).toBeEqual(['COUN ON']);
			expect(
				(result.warnings as string[]).some((warning) => /COUN support on SDS9999Z is unknown/.test(warning)),
			).toBeTruthy();
			assertSent(harness.fake, ['COUN ON', 'COUN?']);
		});
	});
});
