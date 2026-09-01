import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { type CommandEntry, entriesFor, manifest } from '../../../src/devices/power-supply/manifest.ts';
import type { PsuSet } from '../../../src/devices/power-supply/models.ts';
import { tools } from '../../../src/devices/power-supply/tools/index.ts';
import type { Exchange, ExchangeInterceptor } from '../../../src/scpi/connection.ts';
import { payload } from '../../support/assertions.ts';
import { startSupplyHarness } from '../../support/harness.ts';

const expected: Record<string, number> = {
	common: 11,
	instrument: 2,
	measure: 5,
	source: 5,
	protection: 3,
	output: 4,
	timer: 2,
	system: 6,
	lan: 4,
};

describe('power-supply coverage manifest', () => {
	it('lists 42 entries, unique per command set', () => {
		expect(manifest.length).toBe(42);
		expect(entriesFor('SPD1000X').length).toBe(27);
		expect(entriesFor('SPD3303').length).toBe(15);
		for (const set of ['SPD1000X', 'SPD3303'] as const) {
			const ids = entriesFor(set).map(({ id }) => id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it('matches the source coverage map per subsystem', () => {
		const counts: Record<string, number> = {};
		for (const { subsystem } of manifest) counts[subsystem] = (counts[subsystem] ?? 0) + 1;
		expect(counts).toBeEqual(expected);
	});

	it('has tools on every row', () => {
		for (const entry of manifest) {
			expect(entry.tools.length > 0).toBeTruthy();
		}
	});

	it('marks a row destructive for every tool that demands a confirmation', () => {
		const unconfirmed: string[] = [];
		for (const { name, input } of tools) {
			const confirms = Object.keys(input?.shape ?? {}).some((key) => key.startsWith('confirm_'));
			const owned = manifest.filter(({ tools: named }) => named.includes(name));
			if (confirms && !owned.some(({ mutability }) => mutability === 'destructive')) unconfirmed.push(name);
		}
		expect(unconfirmed).toBeEqual([]);
	});

	// INSTrument is excluded by its note: its command form is deliberately never written.
	it('never leaves a row that writes to read-only tools alone', () => {
		const annotations = new Map(tools.map(({ name, annotations: hints }) => [name, hints]));
		const writes = manifest.filter(
			({ mutability, note, tools: named }) => mutability !== 'read' && note === undefined && named.length > 0,
		);
		const readOnly = writes.filter(({ tools: named }) => named.every((name) => annotations.get(name)?.readOnlyHint));
		const undeclared = writes
			.filter(({ mutability }) => mutability === 'destructive')
			.filter(({ tools: named }) => !named.some((name) => annotations.get(name)?.destructiveHint));
		expect(readOnly.map(({ id }) => id)).toBeEqual([]);
		expect(undeclared.map(({ id }) => id)).toBeEqual([]);
	});

	it('implements every row somewhere in the module that owns it', () => {
		const read = (path: string) => readFileSync(new URL(`../../../src/${path}.ts`, import.meta.url), 'utf8');
		const missing = manifest
			.filter(({ id, owner }) => !read(owner).includes(id.replace(/\?$/, '')))
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

// The manifest transcribes the two source documents independently of the tools. Driving every tool against a fake
// supply and matching its wire lines against that transcription turns "the source has a query for this" into a
// checked fact: an undocumented query hangs real hardware until the read times out and tears the connection down.
const fixtures: Record<string, Array<Record<string, unknown>>> = {
	configure_lan: [
		{ netmask: '255.255.255.0', gateway: '10.11.13.1', dhcp: false, confirm_network: true },
		// The address matches the fake's IPaddr? answer, so the no-op path exercises the query without a write
		// that would retire the connection under the tools that follow.
		{ address: '10.11.13.214', confirm_network: true },
	],
	configure_output: [
		{ voltage: 15, current: 0.5, wire_mode: '4W' },
		{ channel: 'CH2', voltage: 5 },
	],
	configure_protection: [{ over_voltage: 16.5, over_current: 8.2 }],
	configure_timer: [{ groups: [{ group: 1, voltage: 3, current: 0.5, seconds: 2 }], enabled: true }],
	delete_state: [{ slot: 1, confirm_delete: true }],
	lock_front_panel: [{ locked: true }, { locked: false }],
	recall_state: [{ slot: 1, confirm_recall: true }],
	save_state: [{ slot: 1, confirm_overwrite: true }],
	scpi_command: [{ command: '*UNLOCK' }],
	scpi_query: [{ command: 'SYSTem:ERRor?' }],
	set_output: [
		{ enabled: true, wave: true },
		{ channel: 'CH3', enabled: false },
	],
	set_track_mode: [{ mode: 'series' }],
};

const argumentsFor = (name: string): Array<Record<string, unknown>> => fixtures[name] ?? [{}];

interface Call {
	tool: string;
	exchanges: Exchange[];
	commands: unknown;
	answered: boolean;
}

async function driveModel(model: string): Promise<Call[]> {
	let exchanges: Exchange[] = [];
	const record: ExchangeInterceptor = (exchange, run) => {
		exchanges.push(exchange);
		return run();
	};
	const harness = await startSupplyHarness(
		model,
		{
			'SYSTem:VERSion?': '2.01.01.06',
			'SYSTem:ERRor?': '0 No Error',
			'INSTrument?': 'CH1',
			'SYSTem:STATus?': '0x0224',
			'MEASure:VOLTage? CH1': '16.000',
			'MEASure:CURRent? CH1': '3.000',
			'MEASure:POWEr? CH1': '48.000',
			'CH1:VOLTage?': '15.000',
			'CH1:CURRent?': '0.500',
			'CH2:VOLTage?': '5.000',
			'OVP?': '16.500',
			'OCP?': '8.200',
			'TIMEr:SET? CH1,1': '3, 0.5, 2',
			'DHCP?': 'OFF',
			'IPaddr?': '10.11.13.214',
			'MASKaddr?': '255.255.255.0',
			'GATEaddr?': '10.11.13.1',
		},
		record,
	);
	const calls: Call[] = [];
	try {
		// One call to get the connection and its *IDN? handshake out of the way, so every record below holds the
		// lines of its own request and nothing else.
		await harness.client.callTool({ name: 'identify', arguments: {} });
		for (const { name } of tools) {
			for (const args of argumentsFor(name)) {
				exchanges = [];
				const result = await harness.client.callTool({ name, arguments: args });
				calls.push({ tool: name, exchanges, commands: payload(result).commands, answered: !result.isError });
			}
		}
		return calls;
	} finally {
		await harness.close();
	}
}

// Every SPD wire line is either a bare mnemonic or a CH<n>:-prefixed one; the manifest lists queries either with
// their question mark (MEASure:CURRent?) or as the query form of a both-forms row (VOLTage).
const rowFor = (entries: readonly CommandEntry[], line: string): CommandEntry | undefined => {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const token = line.split(' ')[0] ?? line;
	const bare = token.replace(/^CH\d:/, '');
	return [token, bare, bare.replace(/\?$/, '')].map((id) => byId.get(id)).find(Boolean);
};

const families: Array<[model: string, sets: PsuSet[]]> = [
	['SPD1168X', ['SPD1000X']],
	['SPD3303C', ['SPD3303']],
	// An unknown SPD model gets the raw-with-warning posture; whatever the tools still send must stay within the
	// union of the two documented sets, because there is no third source to justify anything else.
	['SPD4000', ['SPD1000X', 'SPD3303']],
];

describe('power-supply tools against the manifest', () => {
	const driven = new Map<string, Call[]>();

	before(async () => {
		for (const [model] of families) driven.set(model, await driveModel(model));
	});

	const wire = (model: string, ...kinds: Array<Exchange['kind']>) =>
		new Set(
			(driven.get(model) ?? [])
				.flatMap(({ exchanges }) => exchanges)
				.filter(({ kind }) => kinds.includes(kind))
				.map(({ command }) => command),
		);

	for (const [model, sets] of families) {
		const entries = () => sets.flatMap((set) => entriesFor(set));

		it(`${model}: never queries a form the sources give no query for`, () => {
			const unknown: string[] = [];
			const commandOnly: string[] = [];
			for (const line of wire(model, 'query')) {
				const entry = rowFor(entries(), line);
				if (!entry) unknown.push(line);
				else if (entry.forms === 'command') commandOnly.push(`${line} (${entry.id})`);
			}
			expect(commandOnly).toBeEqual([]);
			expect(unknown).toBeEqual([]);
		});

		it(`${model}: never writes a form the sources give no command for`, () => {
			const unknown: string[] = [];
			const queryOnly: string[] = [];
			for (const line of wire(model, 'command')) {
				const entry = rowFor(entries(), line);
				if (!entry) unknown.push(line);
				else if (entry.forms === 'query') queryOnly.push(`${line} (${entry.id})`);
			}
			expect(queryOnly).toBeEqual([]);
			expect(unknown).toBeEqual([]);
		});
	}

	it('echoes lines it really wrote, on every mutating call it answered', () => {
		const mutates = new Set(tools.filter(({ annotations }) => !annotations.readOnlyHint).map(({ name }) => name));
		const silent: string[] = [];
		const invented: string[] = [];
		for (const { tool, commands, exchanges, answered } of [...driven.values()].flat()) {
			if (!answered || !mutates.has(tool)) continue;
			const written = new Set(exchanges.map(({ command }) => command));
			if (!Array.isArray(commands)) silent.push(tool);
			else invented.push(...commands.filter((line) => !written.has(line)).map((line) => `${tool}: ${line}`));
		}
		expect([...new Set(silent)]).toBeEqual([]);
		expect([...new Set(invented)]).toBeEqual([]);
	});

	it('drives every registered tool to an answer on at least one family', () => {
		const answered = new Set(
			[...driven.values()]
				.flat()
				.filter(({ answered: ok }) => ok)
				.map(({ tool }) => tool),
		);
		const missing = tools.map(({ name }) => name).filter((name) => !answered.has(name));
		expect(missing).toBeEqual([]);
	});

	it('exercises both status decodes and the SPD1000X-only query paths', () => {
		const queried = new Set([...families.map(([model]) => [...wire(model, 'query')])].flat());
		for (const line of [
			'SYSTem:STATus?',
			'OVP?',
			'OCP?',
			'TIMEr:SET? CH1,1',
			'IPaddr?',
			'MASKaddr?',
			'GATEaddr?',
			'DHCP?',
		]) {
			expect(queried.has(line)).toBeTruthy();
		}
	});
});
