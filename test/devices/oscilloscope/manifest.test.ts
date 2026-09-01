import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { type CommandEntry, manifest } from '../../../src/devices/oscilloscope/manifest.ts';
import { features } from '../../../src/devices/oscilloscope/models.ts';
import { tools } from '../../../src/devices/oscilloscope/tools/index.ts';
import type { Exchange, ExchangeInterceptor } from '../../../src/scpi/connection.ts';
import { payload } from '../../support/assertions.ts';
import { startHarness } from '../../support/harness.ts';

const expected: Record<string, number> = {
	common: 3,
	comm_header: 1,
	acquire: 10,
	autoset: 1,
	channel: 9,
	cursor: 4,
	decode: 7,
	digital: 7,
	display: 5,
	history: 4,
	math: 11,
	measure: 9,
	pass_fail: 10,
	print: 1,
	recall: 2,
	reference: 7,
	save: 3,
	status: 1,
	system: 5,
	timebase: 4,
	trigger: 9,
	serial_trigger: 47,
	waveform: 2,
	wgen: 5,
	obsolete: 15,
};

describe('coverage manifest', () => {
	it('lists 182 unique identifiers', () => {
		expect(manifest.length).toBe(182);
		expect(new Set(manifest.map(({ id }) => id)).size).toBe(182);
	});

	it('matches the guide coverage map per subsystem', () => {
		const counts: Record<string, number> = {};
		for (const { subsystem } of manifest) counts[subsystem] = (counts[subsystem] ?? 0) + 1;
		expect(counts).toBeEqual(expected);
	});

	it('has a known support predicate and a consistent response kind', () => {
		for (const entry of manifest) {
			expect(features.includes(entry.support)).toBeTruthy();
			expect(entry.tools.length > 0).toBeTruthy();
			if (entry.forms === 'command') expect(entry.response).toBe('none');
		}
	});

	// get_trigger reads the whole trigger state back, so it covers the three global rows besides the addressed ones.
	// configure_trigger does not: it reads back only what the request wrote, which is why it is not named here.
	it('names every tool a row is covered by, not only the one named after it', () => {
		for (const id of ['TRMD', 'TRWI', 'TRPA']) {
			const entry = manifest.find((row) => row.id === id);
			expect(entry?.tools.includes('get_trigger')).toBeTruthy();
		}
	});

	// A tool that demands an acknowledgement says the operation is hard to undo. The manifest has to say the same
	// about at least one row it owns, or the coverage matrix reads as routine setup where the tool asks for consent.
	it('marks a row destructive for every tool that demands a confirmation', () => {
		const unconfirmed: string[] = [];
		for (const { name, input } of tools) {
			const confirms = Object.keys(input?.shape ?? {}).some((key) => key.startsWith('confirm_'));
			const owned = manifest.filter(({ tools: named }) => named.includes(name));
			if (confirms && !owned.some(({ mutability }) => mutability === 'destructive')) unconfirmed.push(name);
		}
		expect(unconfirmed).toBeEqual([]);
	});

	// A row that changes the scope cannot be owned by read-only tools alone: the manifest already knows which rows
	// write, so an annotation that promises otherwise is a lie the transcription can catch.
	it('never leaves a row that writes to read-only tools alone', () => {
		const annotations = new Map(tools.map(({ name, annotations: hints }) => [name, hints]));
		const writes = manifest.filter(({ mutability, tools: named }) => mutability !== 'read' && named.length > 0);
		const readOnly = writes.filter(({ tools: named }) => named.every((name) => annotations.get(name)?.readOnlyHint));
		const undeclared = writes
			.filter(({ mutability }) => mutability === 'destructive')
			.filter(({ tools: named }) => !named.some((name) => annotations.get(name)?.destructiveHint));
		expect(readOnly.map(({ id }) => id)).toBeEqual([]);
		expect(undeclared.map(({ id }) => id)).toBeEqual([]);
	});

	// The wire tests below prove no tool sends a line the manifest does not list. This is the other direction, as far
	// as source text can carry it: a row whose mnemonic appears nowhere in the module that owns it is a row nothing
	// implements, however confidently its status says otherwise.
	it('implements every row somewhere in the module that owns it', () => {
		const read = (path: string) => readFileSync(new URL(`../../../src/${path}.ts`, import.meta.url), 'utf8');
		const sources = new Map<string, string>();
		const owning = (owner: string): string => {
			const cached = sources.get(owner);
			if (cached !== undefined) return cached;
			const source = read(owner);
			const directory = owner.slice(0, owner.lastIndexOf('/') + 1);
			const siblings = [...source.matchAll(/from '\.\/([\w-]+)\.ts'/g)].map(([, name]) => read(`${directory}${name}`));
			const joined = [source, ...siblings].join('\n');
			sources.set(owner, joined);
			return joined;
		};
		const missing = manifest
			.filter(({ id, owner }) => {
				const bare = id.replace(/^[A-Z]<n>:/, '').replace(/\?$/, '');
				const source = owning(owner);
				return !source.includes(bare) && !source.includes(bare.split(':').pop() ?? bare);
			})
			.map(({ id, owner }) => `${id} (${owner})`);
		expect(missing).toBeEqual([]);
	});

	it('names only registered tools', () => {
		const registered = new Set(tools.map(({ name }) => name));
		for (const { tools: named } of manifest) {
			for (const name of named) expect(registered.has(name)).toBeTruthy();
		}
	});
});

// The manifest transcribes the guide independently of the tools. Driving every tool against a fake scope and matching
// the queries it sends against that transcription turns "the guide has a query for this" into a checked fact: an
// undocumented query hangs real hardware until the read times out and the connection is torn down.
const fixtures: Record<string, Record<string, unknown>> = {
	autoset_scope: { confirm_autoset: true },
	calibrate_scope: { confirm_inputs_disconnected: true },
	change_scope_ip: { address: '10.11.0.230', confirm_disconnect: true },
	configure_acquisition: { time_per_div: '1US' },
	configure_acquisition_display: { interpolation: 'sine' },
	configure_can_decode: { bus: 'B1', display: true },
	configure_can_trigger: { condition: 'START' },
	configure_channel: { channel: 'C1', coupling: 'D1M' },
	configure_communication_header: { mode: 'OFF' },
	configure_cursors: { mode: 'off' },
	configure_decode: { enabled: true },
	configure_digital: { enabled: true },
	configure_display: { grid: 'FULL' },
	configure_fft: { source: 'C1' },
	configure_history: { enabled: true },
	configure_i2c_decode: { bus: 'B1', display: true },
	configure_i2c_trigger: { condition: 'START' },
	configure_lin_decode: { bus: 'B1', display: true },
	configure_lin_trigger: { condition: 'BREAK' },
	configure_math: { operation: 'add', sources: ['C1', 'C2'] },
	configure_measurement_gate: { enabled: true },
	configure_measurement_statistics: { statistics: 'ON' },
	configure_pass_fail: { enabled: true },
	configure_pass_fail_mask: { source: 'C1', create_mask: true, confirm_replace_mask: true },
	configure_pattern_trigger: { c1: 'H', condition: 'AND' },
	configure_reference: { location: 'REFA', source: 'C1', display: true },
	configure_spi_decode: { bus: 'B1', display: true },
	configure_spi_trigger: { edge: 'RISING' },
	configure_system_settings: { buzzer: true },
	configure_timebase: { time_per_div: '1US' },
	configure_trigger: { source: 'C1', coupling: 'DC' },
	configure_trigger_type: { type: 'EDGE', source: 'C1' },
	configure_trigger_window: { window_height: '2V' },
	configure_uart_decode: { bus: 'B1', display: true },
	configure_uart_trigger: { condition: 'START' },
	configure_waveform_generator: { output: false },
	get_channel: { channel: 'C1' },
	get_trigger: { source: 'C1' },
	measure: { channel: 'C1', parameter: 'PKPK' },
	measure_cursors: { source: 'C1', measurement: 'HREL' },
	measure_delay: { source_a: 'C1', source_b: 'C2', type: 'PHA' },
	read_measurement: { channel: 'C1', parameter: 'PKPK' },
	recall_panel_setup: { slot: 1, confirm_recall: true },
	reset_scope: { confirm_reset: true },
	restore_panel_setup: { confirm_restore: true },
	save_panel_setup: { slot: 1, confirm_overwrite: true },
	scpi_command: { command: '*OPC' },
	scpi_query: { command: '*IDN?' },
};

// Tools whose query paths only appear for some of their arguments: a waveform reads different commands per source,
// and every obsolete query the guide gives a target for needs that target supplied.
const variants: Record<string, Array<Record<string, unknown>>> = {
	get_waveform: [
		{ source: 'C1', output: 'summary' },
		{ source: 'MATH', output: 'summary' },
		{ source: 'D0', output: 'summary' },
	],
	send_obsolete_command: [
		{ command: 'ACAL', quick_calibration: true },
		{ command: 'COUN', counter_display: true },
		{ command: 'FILT', channel: 'C1', filter_enabled: true },
		{ command: 'FILTS', channel: 'C1', filter_type: 'BP', upper_limit: '200KHZ', lower_limit: '100KHZ' },
		{ command: 'VPOS', trace: 'TA', vertical_position: '3V' },
		{ command: 'REFS', reference: 'RA', reference_source: 'C1', display: true },
	].map((args) => ({ ...args, confirm_obsolete: true })),
};

const argumentsFor = (name: string): Array<Record<string, unknown>> => variants[name] ?? [fixtures[name] ?? {}];

const bitmap = (() => {
	const image = Buffer.alloc(54, 0x7f);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeUInt32LE(40, 14);
	return image;
})();

const setup = '<setup/>';
const block = Buffer.from(`#9${String(setup.length).padStart(9, '0')}${setup}`, 'latin1');

// Analog and math blocks count bytes, digital blocks count points at one bit each (pp. 264, 268, 270).
const waveform = (trace: string, declared: number, data: number[]): Buffer =>
	Buffer.concat([
		Buffer.from(`${trace}:WF ALL,#9${String(declared).padStart(9, '0')}`, 'latin1'),
		Buffer.from(data),
		Buffer.from('\n\n', 'latin1'),
	]);

const mnemonicOf = (line: string): string => line.split(' ')[0]?.replace(/\?$/, '') ?? '';

// The guide writes the target of a shared command in front of it: C1:VDIV (p. 100), C1-C2:MEAD? (p. 118), TA:VPOS,
// M1:REC, B1:DCIC, the L8 and H8 line groups (p. 79), DI: for the digital second query syntax of SARA? (p. 33) and
// D0:WF? and MATH:WF? (p. 263). The manifest lists such a row under the bare mnemonic or under a numbered form of it,
// so a wire line is looked up under both. Any other prefix belongs to the mnemonic itself, which keeps a line of one
// subsystem off the row of another: MATH is a trace, not a channel, so MATH:VDIV? is not the channel VDIV row.
const target = /^(?:C[1-4](?:-C[1-4])?|D\d{1,2}|[MB]\d{1,2}|T[A-D]|[LH]8|DI|MATH(?=:WF)):/;

const candidates = (mnemonic: string): string[] => {
	const bare = mnemonic.replace(target, '');
	return [mnemonic, `${mnemonic}?`, mnemonic.replace(/^([A-Za-z])\d+:/, '$1<n>:'), bare, `${bare}?`];
};

const rowFor = (line: string): CommandEntry | undefined => {
	const entries = new Map(manifest.map((entry) => [entry.id, entry]));
	return candidates(mnemonicOf(line))
		.map((id) => entries.get(id))
		.find(Boolean);
};

interface Call {
	tool: string;
	exchanges: Exchange[];
	commands: unknown;
	answered: boolean;
}

async function driveModel(model: string): Promise<Call[]> {
	// The interceptor, not the wire, says how a reply was read: SCDP and PNSU are queries the guide writes without a
	// question mark, so the line alone cannot tell a write from a read.
	let exchanges: Exchange[] = [];
	const record: ExchangeInterceptor = (exchange, run) => {
		exchanges.push(exchange);
		return run();
	};
	const harness = await startHarness(
		{
			SCDP: bitmap,
			'PNSU?': block,
			'C1:WF? DAT2': waveform('C1', 4, [0x02, 0xfc, 0x00, 0x7f]),
			'MATH:WF? DAT2': waveform('MATH', 4, [0x02, 0xfc, 0x00, 0x7f]),
			'D0:WF? DAT2': waveform('D0', 4, [0x05]),
			'FTIM?': '00: 05: 12. 650814',
			'*OPC?': '1',
			'*CAL?': '0',
			'CHDR?': 'OFF',
			'INR?': '0',
			'CONET?': '10,11,0,230',
			'DEF?': "EQN,'C1*C2'",
			'MTVD?': '1.00E+00V',
			'SANU? C1': '7.00E+02',
			'SARA?': '1.00E+09',
			'DI:SARA?': '5.00E+08',
			'TDIV?': '1.00E-06',
		},
		undefined,
		record,
	);
	harness.fake.fallback = (line) => (line.endsWith('?') || line.includes('? ') ? 'ON' : undefined);
	harness.fake.replies.set('*IDN?', `Siglent Technologies,${model},SN,7.6.1.20`);
	const calls: Call[] = [];
	// The only fixture the guide cannot supply up front: restore_panel_setup takes an id capture_panel_setup minted.
	let captured = '';
	try {
		// One call to get the connection and its CHDR OFF handshake out of the way, so every record below holds the
		// lines of its own request and nothing else.
		await harness.client.callTool({ name: 'identify', arguments: {} });
		for (const { name } of tools) {
			for (const fixture of argumentsFor(name)) {
				exchanges = [];
				const args = { ...fixture, ...(name === 'restore_panel_setup' && { setup_id: captured }) };
				const result = await harness.client.callTool({ name, arguments: args });
				if (name === 'capture_panel_setup') captured = (payload(result).setup as { id: string }).id;
				calls.push({ tool: name, exchanges, commands: payload(result).commands, answered: !result.isError });
			}
		}
		return calls;
	} finally {
		await harness.close();
	}
}

describe('tools against the manifest', () => {
	let driven: Call[];

	const wire = (...kinds: Array<Exchange['kind']>) =>
		new Map(
			driven
				.flatMap(({ exchanges }) => exchanges)
				.filter(({ kind }) => kinds.includes(kind))
				.map((exchange) => [exchange.command, exchange] as const),
		);

	// SDS1102CML+ is the third family because the other two reach neither the obsolete commands (the SDS1000X-E has
	// none and the SDS2000X table excludes most) nor a model the guide gives no MSO or math to.
	before(async () => {
		driven = (await Promise.all(['SDS1104X-E', 'SDS2104X', 'SDS1102CML+'].map(driveModel))).flat();
	});

	it('never queries a command the guide gives no query form for', () => {
		const unknown: string[] = [];
		const commandOnly: string[] = [];
		for (const line of wire('query', 'binary').keys()) {
			const entry = rowFor(line);
			if (!entry) unknown.push(line);
			else if (entry.forms === 'command') commandOnly.push(`${line} (${entry.id})`);
		}
		expect(commandOnly).toBeEqual([]);
		expect(unknown).toBeEqual([]);
	});

	// The same transcription checks the write side: a mnemonic or a parameter order the guide does not have is a
	// command the scope answers with an error the server never sees.
	it('never writes a command the guide gives no command form for', () => {
		const unknown: string[] = [];
		const queryOnly: string[] = [];
		for (const line of wire('command').keys()) {
			const entry = rowFor(line);
			if (!entry) unknown.push(line);
			else if (entry.forms === 'query') queryOnly.push(`${line} (${entry.id})`);
		}
		expect(queryOnly).toBeEqual([]);
		expect(unknown).toBeEqual([]);
	});

	// The other half of the hang class: a headerless binary reply read with the text reader waits for a line feed that
	// never comes, and a text reply read as a block waits for a length header that never comes.
	it('reads every reply with the reader the manifest transcribes for it', () => {
		const mismatched: string[] = [];
		for (const [line, { kind }] of wire('query', 'binary')) {
			const entry = rowFor(line);
			if (!entry) continue;
			if (kind === 'binary' && entry.response === 'text') mismatched.push(`${line} read as a block (${entry.id})`);
			if (kind === 'query' && entry.response === 'binary') mismatched.push(`${line} read as a line (${entry.id})`);
		}
		expect(mismatched).toBeEqual([]);
		const asBlocks = new Set([...wire('binary').keys()].map((line) => rowFor(line)?.id));
		for (const { id } of manifest.filter(({ response }) => response !== 'text' && response !== 'none')) {
			expect(asBlocks.has(id)).toBeTruthy();
		}
	});

	// The paths two families and one fixture per tool could not reach: an obsolete query needs a series its own table
	// says yes to and, for five of them, a target; MATH and the digital lines need a waveform source that is not a
	// channel. Naming them keeps the net from quietly shrinking back to what it used to cover.
	it('reaches the obsolete and the MATH and digital waveform queries', () => {
		const asked = new Set(wire('query', 'binary').keys());
		const paths = [
			'COUN?',
			'C1:FILT?',
			'C1:FILTS?',
			'TA:VPOS?',
			'REFS? REF,RA',
			'DEF?',
			'MTVD?',
			'SANU? C1',
			'MATH:WF? DAT2',
			'DI:SARA?',
			'D0:WF? DAT2',
		];
		expect(paths.filter((line) => !asked.has(line))).toBeEqual([]);
	});

	// A call that changed the scope has to say which lines did it: the commands echo is what a caller reasons about
	// after a partial failure, so no mutating tool may answer without one or name a line it never sent. It may send
	// more than it names, because re-applying the communication header and re-identifying after a reset are the
	// session's own housekeeping rather than the request.
	it('echoes lines it really wrote, on every mutating call it answered', () => {
		const mutates = new Set(tools.filter(({ annotations }) => !annotations.readOnlyHint).map(({ name }) => name));
		const silent: string[] = [];
		const invented: string[] = [];
		for (const { tool, commands, exchanges, answered } of driven) {
			if (!answered || !mutates.has(tool)) continue;
			const written = new Set(exchanges.map(({ command }) => command));
			// A command that carries a block is logged by its byte count, so that one is matched on its mnemonic.
			const blocks = new Set([...written].filter((line) => / <\d+ bytes>$/.test(line)).map(mnemonicOf));
			const carried = (line: string) => written.has(line) || blocks.has(mnemonicOf(line));
			if (!Array.isArray(commands)) silent.push(tool);
			else invented.push(...commands.filter((line) => !carried(line)).map((line) => `${tool}: ${line}`));
		}
		expect([...new Set(silent)]).toBeEqual([]);
		expect([...new Set(invented)]).toBeEqual([]);
	});

	it('drives every registered tool on at least one of the driven families', () => {
		const answered = new Set(driven.filter(({ answered: ok }) => ok).map(({ tool }) => tool));
		const missing = tools.map(({ name }) => name).filter((name) => !answered.has(name));
		expect(missing).toBeEqual([]);
	});
});
