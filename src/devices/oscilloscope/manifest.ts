import type { Feature } from './models.ts';

export type Forms = 'command' | 'query' | 'both';
export type Mutability = 'read' | 'setup' | 'destructive';
export type Response = 'text' | 'binary' | 'both' | 'none';

export interface CommandEntry {
	id: string;
	subsystem: string;
	forms: Forms;
	mutability: Mutability;
	response: Response;
	support: Feature;
	owner: string;
	tools: readonly string[];
}

type Tweak = Partial<Pick<CommandEntry, 'mutability' | 'response' | 'support' | 'owner' | 'tools'>>;
type Row = [id: string, forms: Forms, tweak?: Tweak];

const done = (...tools: string[]): Tweak => ({ tools });
// Mutability is per mnemonic, not per form: PNSU, CONET and WGEN are destructive to write and harmless to read, so
// their rows are destructive while one of the tools they name is the read-only getter of the query form.
const destructive: Tweak = { mutability: 'destructive' };
const digital = done('get_digital', 'configure_digital');
const display = done('get_display', 'configure_display');
const history = done('get_history', 'configure_history');
const math = done('get_math', 'configure_math');
const fft = { owner: 'devices/oscilloscope/tools/fft', ...done('get_fft', 'configure_fft') };
const gate = done('get_measurement_gate', 'configure_measurement_gate');
const mask = done('get_pass_fail_mask', 'configure_pass_fail_mask');
const passFail = done('get_pass_fail', 'configure_pass_fail');
const enabling = done('get_pass_fail', 'configure_pass_fail', 'configure_pass_fail_mask');
const reference = done('get_reference', 'configure_reference');
const timebase = done('get_timebase', 'configure_timebase');
const waveform = done('get_waveform');
const wgen = done('get_waveform_generator');
const trigger = done('get_trigger', 'configure_trigger');
const i2cTrigger = done('get_i2c_trigger', 'configure_i2c_trigger');
const spiTrigger = done('get_spi_trigger', 'configure_spi_trigger');
const uartTrigger = done('get_uart_trigger', 'configure_uart_trigger');
const canTrigger = done('get_can_trigger', 'configure_can_trigger');
const linTrigger = done('get_lin_trigger', 'configure_lin_trigger');
const main = done('get_acquisition', 'configure_acquisition', 'get_timebase', 'configure_timebase');
const obsolete = done('get_obsolete_settings', 'send_obsolete_command');
const preferences = {
	owner: 'devices/oscilloscope/tools/system-settings',
	...done('get_system_settings', 'configure_system_settings'),
};

function subsystem(name: string, owner: string, support: Feature, rows: Row[]): CommandEntry[] {
	return rows.map(([id, forms, tweak]) => ({
		id,
		subsystem: name,
		forms,
		mutability: forms === 'query' ? 'read' : 'setup',
		response: forms === 'command' ? 'none' : 'text',
		support,
		owner,
		tools: [],
		...tweak,
	}));
}

export const manifest: readonly CommandEntry[] = [
	...subsystem('common', 'devices/oscilloscope/tools/system', 'base', [
		['*IDN?', 'query', done('identify')],
		['*OPC', 'both', done('wait_until_complete', 'mark_operation_complete')],
		['*RST', 'command', { ...destructive, ...done('reset_scope') }],
	]),
	...subsystem('comm_header', 'devices/oscilloscope/scope', 'base', [
		[
			'CHDR',
			'both',
			{
				owner: 'devices/oscilloscope/tools/system',
				...done('get_communication_header', 'configure_communication_header'),
			},
		],
	]),
	...subsystem('acquire', 'devices/oscilloscope/tools/acquisition', 'base', [
		['ARM', 'command', done('configure_acquisition')],
		['STOP', 'command', done('configure_acquisition')],
		['ACQW', 'both', done('get_acquisition', 'configure_acquisition')],
		['AVGA', 'both', done('get_acquisition', 'configure_acquisition')],
		['MSIZ', 'both', done('get_acquisition', 'configure_acquisition')],
		['SAST?', 'query', done('get_acquisition')],
		['SARA?', 'query', done('get_acquisition')],
		['SANU?', 'query', done('get_acquisition')],
		['SXSA', 'both', done('get_acquisition', 'configure_acquisition_display')],
		['XYDS', 'both', done('get_acquisition', 'configure_acquisition_display')],
	]),
	...subsystem('autoset', 'devices/oscilloscope/tools/autoset', 'base', [
		['ASET', 'command', { ...destructive, ...done('autoset_scope') }],
	]),
	...subsystem('channel', 'devices/oscilloscope/tools/channel', 'base', [
		['ATTN', 'both', done('get_channel', 'configure_channel')],
		['BWL', 'both', done('get_channel', 'configure_channel')],
		['CPL', 'both', done('get_channel', 'configure_channel')],
		['OFST', 'both', done('get_channel', 'configure_channel')],
		['SKEW', 'both', done('get_channel', 'configure_channel')],
		['TRA', 'both', done('get_channel', 'configure_channel')],
		['UNIT', 'both', done('get_channel', 'configure_channel')],
		['VDIV', 'both', done('get_channel', 'configure_channel')],
		['INVS', 'both', done('get_channel', 'configure_channel')],
	]),
	...subsystem('cursor', 'devices/oscilloscope/tools/cursor', 'base', [
		['CRMS', 'both', done('configure_cursors', 'get_cursors')],
		['CRST', 'both', done('configure_cursors', 'get_cursors')],
		['CRTY', 'both', done('configure_cursors', 'get_cursors')],
		['CRVA?', 'query', done('measure_cursors')],
	]),
	...subsystem('decode', 'devices/oscilloscope/tools/decode', 'xe', [
		['DCST', 'both', done('get_decode', 'configure_decode')],
		['DCPA', 'command', done('configure_decode')],
		['B<n>:DCIC', 'command', done('configure_i2c_decode')],
		['B<n>:DCSP', 'command', done('configure_spi_decode')],
		['B<n>:DCUT', 'command', done('configure_uart_decode')],
		['B<n>:DCCN', 'command', done('configure_can_decode')],
		['B<n>:DCLN', 'command', done('configure_lin_decode')],
	]),
	...subsystem('digital', 'devices/oscilloscope/tools/digital', 'mso_xe', [
		['DGCH', 'both', { support: 'mso', ...digital }],
		['DGST', 'both', { support: 'mso', ...digital }],
		['DGTH', 'both', { support: 'mso', ...digital }],
		['DI:SW', 'both', digital],
		['D<n>:TRA', 'both', digital],
		['TSM', 'both', digital],
		['CUS', 'both', digital],
	]),
	...subsystem('display', 'devices/oscilloscope/tools/display', 'base', [
		['DTJN', 'both', display],
		['GRDS', 'both', display],
		['INTS', 'both', display],
		['MENU', 'both', display],
		['PESU', 'both', display],
	]),
	...subsystem('history', 'devices/oscilloscope/tools/history', 'xe', [
		// The FRAM command is universal, only the FRAM? query is SDS1000X-E (p. 89); the row carries the narrower support.
		['FRAM', 'both', history],
		// Format 1 is text and format 2 is a keyword-less binary blob, one per series (p. 91), so both readers are right.
		['FTIM?', 'query', { support: 'base', response: 'both', ...done('get_history') }],
		['HSMD', 'both', history],
		['HSLST', 'both', history],
	]),
	...subsystem('math', 'devices/oscilloscope/tools/math', 'base', [
		['DEF', 'both', math],
		['MATH:INVS', 'both', math],
		['MTVD', 'both', math],
		['MTVP', 'both', math],
		['FFTC', 'both', { support: 'xe', ...fft }],
		['FFTF', 'both', fft],
		['FFTP', 'both', { support: 'xe', ...fft }],
		['FFTS', 'both', fft],
		['FFTT?', 'query', { support: 'xe', ...fft }],
		['FFTU', 'both', { support: 'xe', ...fft }],
		['FFTW', 'both', fft],
	]),
	...subsystem('measure', 'devices/oscilloscope/tools/measure', 'base', [
		['CYMT?', 'query', done('read_frequency_counter')],
		['MEAD', 'both', done('measure_delay')],
		['PACU', 'command', done('measure')],
		['PAVA?', 'query', done('measure', 'read_measurement', 'list_measurements', 'get_measurement_statistics')],
		['PASTAT', 'both', { support: 'xe', ...done('get_measurement_statistics', 'configure_measurement_statistics') }],
		['MEACL', 'command', { support: 'xe', ...destructive, ...done('clear_measurements') }],
		['MEGS', 'both', { support: 'xe', ...gate }],
		['MEGA', 'command', { support: 'xe', ...gate }],
		['MEGB', 'command', { support: 'xe', ...gate }],
	]),
	...subsystem('pass_fail', 'devices/oscilloscope/tools/passfail', 'xe', [
		['PACL', 'command', done('reset_pass_fail_statistics')],
		['PFBF', 'both', mask],
		['PFCM', 'command', { ...destructive, ...mask }],
		['PFDD?', 'query', done('get_pass_fail')],
		['PFDS', 'both', passFail],
		['PFEN', 'both', enabling],
		['PFFS', 'both', passFail],
		['PFOP', 'both', enabling],
		['PFSC', 'both', mask],
		['PFST', 'both', mask],
	]),
	...subsystem('print', 'devices/oscilloscope/tools/panel', 'base', [
		['SCDP', 'query', { response: 'binary', ...done('capture_screenshot') }],
	]),
	...subsystem('recall', 'devices/oscilloscope/tools/panel', 'base', [
		['*RCL', 'command', { ...destructive, ...done('recall_panel_setup') }],
		['RCPN', 'command', { ...destructive, ...done('recall_panel_setup') }],
	]),
	...subsystem('reference', 'devices/oscilloscope/tools/reference', 'xe', [
		['REFCL', 'command', { ...destructive, ...done('close_reference') }],
		['REFDS', 'both', reference],
		['REFLA', 'both', reference],
		['REFPO', 'both', reference],
		['REFSA', 'command', { ...destructive, ...done('configure_reference') }],
		['REFSC', 'both', reference],
		['REFSR', 'both', reference],
	]),
	...subsystem('save', 'devices/oscilloscope/tools/panel', 'base', [
		['*SAV', 'command', { ...destructive, ...done('save_panel_setup') }],
		['PNSU', 'both', { ...destructive, response: 'binary', ...done('capture_panel_setup', 'restore_panel_setup') }],
		['STPN', 'command', { ...destructive, ...done('save_panel_setup') }],
	]),
	// INR? clears the register it reports, so it changes state despite being a query (p. 174).
	...subsystem('status', 'devices/oscilloscope/tools/system-settings', 'base', [
		['INR?', 'query', { mutability: 'setup', ...done('read_status_events') }],
	]),
	...subsystem('system', 'devices/oscilloscope/tools/system', 'base', [
		['*CAL?', 'query', { ...destructive, ...done('calibrate_scope') }],
		['BUZZ', 'both', preferences],
		['CONET', 'both', { ...destructive, ...done('get_network_address', 'change_scope_ip') }],
		['SCSV', 'both', preferences],
		['EMOD', 'both', preferences],
	]),
	...subsystem('timebase', 'devices/oscilloscope/tools/timebase', 'base', [
		['TDIV', 'both', main],
		['TRDL', 'both', main],
		['HMAG', 'both', timebase],
		['HPOS', 'both', timebase],
	]),
	...subsystem('trigger', 'devices/oscilloscope/tools/trigger', 'base', [
		['SET50', 'command', done('configure_trigger')],
		['TRCP', 'both', trigger],
		['TRLV', 'both', trigger],
		['TRLV2', 'both', trigger],
		[
			'TRMD',
			'both',
			{
				owner: 'devices/oscilloscope/tools/acquisition',
				...done('get_acquisition', 'configure_acquisition', 'get_trigger'),
			},
		],
		['TRPA', 'both', done('get_trigger', 'configure_pattern_trigger')],
		['TRSE', 'both', done('get_trigger', 'configure_trigger', 'configure_trigger_type')],
		['TRSL', 'both', trigger],
		['TRWI', 'both', done('get_trigger', 'configure_trigger_window')],
	]),
	...subsystem('serial_trigger', 'devices/oscilloscope/tools/serial-trigger', 'xe', [
		['TRIIC:SCL', 'both', i2cTrigger],
		['TRIIC:SDA', 'both', i2cTrigger],
		['TRIIC:CON', 'both', i2cTrigger],
		['TRIIC:ADDR', 'both', i2cTrigger],
		['TRIIC:DATA', 'both', i2cTrigger],
		['TRIIC:DAT2', 'both', i2cTrigger],
		['TRIIC:QUAL', 'both', i2cTrigger],
		['TRIIC:RW', 'both', i2cTrigger],
		['TRIIC:ALEN', 'both', i2cTrigger],
		['TRIIC:DLEN', 'both', i2cTrigger],
		['TRSPI:CLK', 'both', spiTrigger],
		['TRSPI:CLK:EDGE', 'both', spiTrigger],
		['TRSPI:CLK:TIM', 'both', spiTrigger],
		['TRSPI:MOSI', 'both', spiTrigger],
		['TRSPI:MISO', 'both', spiTrigger],
		['TRSPI:CSTP', 'both', spiTrigger],
		['TRSPI:CS', 'both', spiTrigger],
		['TRSPI:NCS', 'both', spiTrigger],
		['TRSPI:TRTY', 'both', spiTrigger],
		['TRSPI:DATA', 'command', spiTrigger],
		['TRSPI:DLEN', 'both', spiTrigger],
		['TRSPI:BIT', 'both', spiTrigger],
		['TRUART:RX', 'both', uartTrigger],
		['TRUART:TX', 'both', uartTrigger],
		['TRUART:TRTY', 'both', uartTrigger],
		['TRUART:CON', 'both', uartTrigger],
		['TRUART:QUAL', 'both', uartTrigger],
		['TRUART:DATA', 'both', uartTrigger],
		['TRUART:BAUD', 'both', uartTrigger],
		['TRUART:DLEN', 'both', uartTrigger],
		['TRUART:PAR', 'both', uartTrigger],
		['TRUART:POL', 'both', uartTrigger],
		['TRUART:STOP', 'both', uartTrigger],
		['TRUART:BIT', 'both', uartTrigger],
		['TRCAN:CANH', 'both', canTrigger],
		['TRCAN:CON', 'both', canTrigger],
		['TRCAN:ID', 'both', canTrigger],
		['TRCAN:IDL', 'both', canTrigger],
		['TRCAN:DATA', 'both', canTrigger],
		['TRCAN:DAT2', 'both', canTrigger],
		['TRCAN:BAUD', 'both', canTrigger],
		['TRLIN:SRC', 'both', linTrigger],
		['TRLIN:CON', 'both', linTrigger],
		['TRLIN:ID', 'both', linTrigger],
		['TRLIN:DATA', 'both', linTrigger],
		['TRLIN:DAT2', 'both', linTrigger],
		['TRLIN:BAUD', 'both', linTrigger],
	]),
	...subsystem('waveform', 'devices/oscilloscope/tools/waveform', 'base', [
		['WF?', 'query', { response: 'binary', ...waveform }],
		['WFSU', 'both', waveform],
	]),
	...subsystem('wgen', 'devices/oscilloscope/tools/wgen', 'awg', [
		['ARWV', 'command', done('configure_waveform_generator')],
		['PROD?', 'query', wgen],
		['STL?', 'query', wgen],
		['WGEN', 'both', { ...destructive, ...done('get_waveform_generator', 'configure_waveform_generator') }],
		['WVPR?', 'query', wgen],
	]),
	...subsystem('obsolete', 'devices/oscilloscope/tools/obsolete', 'obsolete', [
		['ACAL', 'both', { ...destructive, ...obsolete }],
		['AUTTS', 'both', obsolete],
		['COUN', 'both', obsolete],
		['CRAU', 'command', obsolete],
		['CSVS', 'both', { ...destructive, ...obsolete }],
		['DATE', 'both', obsolete],
		['FFTZ', 'both', obsolete],
		['FILT', 'both', obsolete],
		['FILTS', 'both', obsolete],
		['PDET', 'both', obsolete],
		['PFCT', 'both', obsolete],
		['PERS', 'both', obsolete],
		['REC', 'command', { ...destructive, ...obsolete }],
		['REFS', 'both', { ...destructive, ...obsolete }],
		['VPOS', 'both', obsolete],
	]),
];
