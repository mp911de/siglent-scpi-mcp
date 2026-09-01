import type { PsuSet } from './models.ts';

export type Forms = 'command' | 'query' | 'both';
export type Mutability = 'read' | 'setup' | 'destructive';

export interface CommandEntry {
	id: string;
	subsystem: string;
	set: PsuSet;
	forms: Forms;
	mutability: Mutability;
	owner: string;
	tools: readonly string[];
	// The reason one form of the row is not covered, rendered into docs/command-coverage.md.
	note?: string;
}

type Tweak = Partial<Pick<CommandEntry, 'mutability' | 'owner' | 'tools' | 'note'>>;
type Row = [id: string, forms: Forms, tweak?: Tweak];

const done = (...tools: string[]): Tweak => ({ tools });
const destructive: Tweak = { mutability: 'destructive' };

function subsystem(name: string, set: PsuSet, owner: string, rows: Row[]): CommandEntry[] {
	return rows.map(([id, forms, tweak]) => ({
		id,
		subsystem: name,
		set,
		forms,
		mutability: forms === 'query' ? 'read' : 'setup',
		owner,
		tools: [],
		...tweak,
	}));
}

// Transcribed from the SPD1000X User Manual E03B SCPI chapter. Corrected transcriptions, each a plain misprint in
// the source:
// - VOLTage (p. 58) prints its query's command format as `<SOURce>:CURRent?`; the example and return info on
//   p. 59 are `CH1:VOLTage?`, which is what is transcribed.
// - IPaddr? (p. 62) and MASKaddr? (p. 63) print `SYSTem:VERSion?` as their example line; the queries themselves
//   are `IPaddr?` and `MASKaddr?`.
// - The GATEaddr query (p. 63) prints its command format as `MASKaddr?`; transcribed as `GATEaddr?`.
// SYSTem:ERRor? is left to the raw scpi_query tool: neither response format nor an example is documented, and
// reading it pops the error queue.
const spd1000x: CommandEntry[] = [
	...subsystem('common', 'SPD1000X', 'devices/power-supply/tools/system', [
		['*IDN?', 'query', done('identify')],
		['*SAV', 'command', { ...destructive, ...done('save_state') }],
		['*RCL', 'command', { ...destructive, ...done('recall_state') }],
		['*DEL', 'command', { ...destructive, ...done('delete_state') }],
		['*LOCK', 'command', done('lock_front_panel')],
		['*UNLOCK', 'command', done('lock_front_panel')],
	]),
	...subsystem('instrument', 'SPD1000X', 'devices/power-supply/tools/system', [
		// The command form is deliberately unused: every tool addresses its channel explicitly, so the stateful
		// channel selection never has to be written on a shared connection.
		[
			'INSTrument',
			'both',
			{ tools: ['get_power_status'], note: 'The command form selects a channel and is deliberately never written' },
		],
	]),
	...subsystem('measure', 'SPD1000X', 'devices/power-supply/tools/output', [
		['MEASure:CURRent?', 'query', done('measure_output')],
		['MEASure:VOLTage?', 'query', done('measure_output')],
		['MEASure:POWEr?', 'query', done('measure_output')],
	]),
	...subsystem('source', 'SPD1000X', 'devices/power-supply/tools/output', [
		['CURRent', 'both', done('configure_output', 'get_output')],
		['VOLTage', 'both', done('configure_output', 'get_output')],
		['MODE:SET', 'command', done('configure_output')],
	]),
	...subsystem('protection', 'SPD1000X', 'devices/power-supply/tools/protection', [
		['OVP', 'both', done('configure_protection')],
		['OCP', 'both', done('configure_protection')],
		['OUTPut:RESEt:PROTect', 'command', done('clear_protection')],
	]),
	...subsystem('output', 'SPD1000X', 'devices/power-supply/tools/output', [
		['OUTPut', 'command', done('set_output')],
		['OUTPut:WAVE', 'command', done('set_output')],
	]),
	...subsystem('timer', 'SPD1000X', 'devices/power-supply/tools/timer', [
		['TIMEr:SET', 'both', done('configure_timer')],
		['TIMEr', 'command', done('configure_timer')],
	]),
	...subsystem('system', 'SPD1000X', 'devices/power-supply/tools/system', [
		['SYSTem:ERRor?', 'query', done('scpi_query')],
		['SYSTem:VERSion?', 'query', done('get_power_status')],
		['SYSTem:STATus?', 'query', done('get_power_status')],
	]),
	...subsystem('lan', 'SPD1000X', 'devices/power-supply/tools/lan', [
		['IPaddr', 'both', { ...destructive, ...done('configure_lan') }],
		['MASKaddr', 'both', { ...destructive, ...done('configure_lan') }],
		['GATEaddr', 'both', { ...destructive, ...done('configure_lan') }],
		['DHCP', 'both', { ...destructive, ...done('configure_lan') }],
	]),
];

// Transcribed from the SPD3303C QuickStart E02A Remote Control chapter. No *DEL, no
// MEASure:POWEr?, no OVP/OCP/MODE/TIMEr/LAN commands, and OUTPut:TRACK has no query form.
const spd3303: CommandEntry[] = [
	...subsystem('common', 'SPD3303', 'devices/power-supply/tools/system', [
		['*IDN?', 'query', done('identify')],
		['*SAV', 'command', { ...destructive, ...done('save_state') }],
		['*RCL', 'command', { ...destructive, ...done('recall_state') }],
		['*LOCK', 'command', done('lock_front_panel')],
		['*UNLOCK', 'command', done('lock_front_panel')],
	]),
	...subsystem('instrument', 'SPD3303', 'devices/power-supply/tools/system', [
		[
			'INSTrument',
			'both',
			{ tools: ['get_power_status'], note: 'The command form selects a channel and is deliberately never written' },
		],
	]),
	...subsystem('measure', 'SPD3303', 'devices/power-supply/tools/output', [
		['MEASure:CURRent?', 'query', done('measure_output')],
		['MEASure:VOLTage?', 'query', done('measure_output')],
	]),
	...subsystem('source', 'SPD3303', 'devices/power-supply/tools/output', [
		['CURRent', 'both', done('configure_output', 'get_output')],
		['VOLTage', 'both', done('configure_output', 'get_output')],
	]),
	...subsystem('output', 'SPD3303', 'devices/power-supply/tools/output', [
		['OUTPut', 'command', done('set_output')],
		['OUTPut:TRACK', 'command', done('set_track_mode')],
	]),
	...subsystem('system', 'SPD3303', 'devices/power-supply/tools/system', [
		['SYSTem:ERRor?', 'query', done('scpi_query')],
		['SYSTem:VERSion?', 'query', done('get_power_status')],
		['SYSTem:STATus?', 'query', done('get_power_status')],
	]),
];

export const manifest: readonly CommandEntry[] = [...spd1000x, ...spd3303];

export const entriesFor = (set: PsuSet): CommandEntry[] => manifest.filter((entry) => entry.set === set);
