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
import { type Harness, startHarness } from '../../../support/harness.ts';

const all =
	'C1:PAVA MAX,2.04E+00V,MIN,-2.16E+00V,PKPK,4.20E+00V,TOP,2.00E+00V,BASE,-2.08E+00V,AMPL,4.08E+00V,MEAN,-1.95E-02V,CMEAN,-6.30E-03V,STDEV,1.46E+00V,VSTD,1.46E+00V,RMS,1.46E+00V,CRMS,1.46E+00V,OVSN,1.96%,FPRE,0.98%,OVSP,0.98%,RPRE,0.00%,LEVELX,0.00E+00V,PER,4.00E-08S,FREQ,2.50E+07Hz,PWID,****,NWID,****,RISE,4.29E-09S,FALL,1.14E-08S,WID,9.99E-08S,DUTY,****,NDUTY,****,DELAY,-6.01E-08S,TIMEL,3.97E-08S';

const custall = 'PAVA CUST1:C1,PKPK,4.08E+00V;CUST2:C3,FREQ,1.00E+06Hz;CUST3:OFF;CUST4:OFF;CUST5:OFF';
const stat1 = 'PAVA STAT1 C1 PKPK:cur,4.08E+00V,mean,4.07E+00V,min,4.00E+00V,max,4.10E+00V,std-dev,1.41E-02V,count,171';
const stat2 =
	'PAVA STAT2 C3 FREQ:cur,1.00E+06Hz,mean,1.00E+06Hz,min,9.97E+05Hz,max,1.00E+06Hz,std-dev,1.41E+03Hz,count,171';

const replies = {
	'C1:PAVA? PKPK': 'C1:PAVA PKPK,1.04E+00V',
	'C2:PAVA? RISE': 'RISE,3.6E-09S',
	'C3:PAVA? FREQ': 'C3:PAVA FREQ,****',
	'C1:PAVA? ALL': all,
	'PAVA? CUSTALL': custall,
	'PAVA? CUST1': 'PAVA CUST1:C1,PKPK,4.08E+00V',
	'PAVA? STAT1': stat1,
	'PAVA? STAT2': stat2,
	'PASTAT?': 'PASTAT ON',
	'CYMT?': 'CYMT 2.50E+07Hz',
	'C2-C4:MEAD? PHA': 'C2-C4:MEAD PHA,-89.46degree',
	'C1-C2:MEAD? SKEW': 'C1-C2:MEAD SKEW,1.24E-04S',
	'MEGS?': 'MEGS ON',
};

const connect = async (replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> => {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SDS1EBAC0L0098,7.6.1.20` });
	await harness.client.callTool({ name: 'identify', arguments: {} });
	return harness;
};

const invoke = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const call = (harness: Harness, args: Record<string, unknown>) => invoke(harness, 'measure', args);

async function withReply(harness: Harness, query: string, reply: string, run: () => Promise<void>): Promise<void> {
	harness.fake.replies.set(query, reply);
	try {
		await run();
	} finally {
		harness.fake.replies.set(query, replies[query as keyof typeof replies]);
	}
}

describe('measure tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await startHarness(replies);
		await harness.client.callTool({ name: 'identify', arguments: {} });
	});

	after(() => harness.close());

	it('installs the measurement, then reads the headered value', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, { channel: 'C1', parameter: 'PKPK' }));
		assertSent(harness.fake, ['PACU PKPK,C1', 'C1:PAVA? PKPK']);
		expect(result.commands).toBeEqual(['PACU PKPK,C1']);
		expect(result.value).toBeEqual({ value: 1.04, unit: 'V', raw: '1.04E+00V' });
		expect(result.raw).toBe('C1:PAVA PKPK,1.04E+00V');
		expect(result.channel).toBe('C1');
		expect(result.parameter).toBe('PKPK');
	});

	it('reads a headerless value', async () => {
		const result = payload(await call(harness, { channel: 'C2', parameter: 'RISE' }));
		expect(result.value).toBeEqual({ value: 3.6e-9, unit: 'S', raw: '3.6E-09S' });
	});

	it('keeps an unmeasurable value as raw text', async () => {
		const result = payload(await call(harness, { channel: 'C3', parameter: 'FREQ' }));
		expect(result.value).toBeEqual({ raw: '****' });
		expect(result.raw).toBe('C3:PAVA FREQ,****');
	});

	it('splits the ALL snapshot into one quantity per parameter', async () => {
		const result = payload(await call(harness, { channel: 'C1', parameter: 'ALL' }));
		const values = result.values as Record<string, unknown>;
		expect(result.value).toBe(undefined);
		expect(values.MAX).toBeEqual({ value: 2.04, unit: 'V', raw: '2.04E+00V' });
		expect(values.FREQ).toBeEqual({ value: 2.5e7, unit: 'Hz', raw: '2.50E+07Hz' });
		expect(values.OVSN).toBeEqual({ value: 1.96, unit: '%', raw: '1.96%' });
		expect(values.PWID).toBeEqual({ raw: '****' });
		expect(Object.keys(values).length).toBe(28);
		expect(result.raw).toBe(all);
	});

	it('is annotated as mutating because PACU changes the measurement pane', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'measure')?.annotations;
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(false);
	});

	it('rejects an unknown parameter without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'measure', { channel: 'C1', parameter: 'VMAX' });
	});

	it('reads a parameter passively, without installing it', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'read_measurement', { channel: 'C1', parameter: 'PKPK' }));
		assertSent(harness.fake, ['C1:PAVA? PKPK']);
		expect(result.value).toBeEqual({ value: 1.04, unit: 'V', raw: '1.04E+00V' });
		await assertReadOnly(harness.client, 'read_measurement');
	});

	it('rejects a channel the scope does not have without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'read_measurement', { channel: 'C5', parameter: 'PKPK' });
	});

	it('lists the installed slots with the slot numbers the scope reports', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'list_measurements'));
		assertSent(harness.fake, ['PAVA? CUSTALL']);
		expect(result.slots).toBeEqual([
			{
				slot: 1,
				installed: true,
				source: 'C1',
				parameter: 'PKPK',
				value: { value: 4.08, unit: 'V', raw: '4.08E+00V' },
			},
			{
				slot: 2,
				installed: true,
				source: 'C3',
				parameter: 'FREQ',
				value: { value: 1e6, unit: 'Hz', raw: '1.00E+06Hz' },
			},
			{ slot: 3, installed: false },
			{ slot: 4, installed: false },
			{ slot: 5, installed: false },
		]);
		expect(result.raw).toBe(custall);
		await assertReadOnly(harness.client, 'list_measurements');
	});

	it('reads a single custom slot', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'list_measurements', { slot: 1 }));
		assertSent(harness.fake, ['PAVA? CUST1']);
		expect((result.slots as Record<string, unknown>[])[0]?.parameter).toBeEqual('PKPK');
	});

	it('rejects a slot outside 1-5 without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'list_measurements', { slot: 6 });
	});

	it('reads statistics for every installed slot', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'get_measurement_statistics'));
		assertSent(harness.fake, ['PASTAT?', 'PAVA? CUSTALL', 'PAVA? STAT1', 'PAVA? STAT2']);
		expect(result.statistics).toBe('ON');
		expect(result.warnings).toBe(undefined);
		const [first, second] = result.measurements as Record<string, unknown>[];
		expect(first?.slot).toBe(1);
		expect(first?.source).toBe('C1');
		expect(first?.parameter).toBe('PKPK');
		const values = first?.statistics as Record<string, { value?: number; unit?: string; raw?: string }>;
		expect(values.cur).toBeEqual({ value: 4.08, unit: 'V', raw: '4.08E+00V' });
		expect(values['std-dev']).toBeEqual({ value: 0.0141, unit: 'V', raw: '1.41E-02V' });
		expect(values.count?.value).toBe(171);
		expect(second?.slot).toBe(2);
		expect(second?.raw).toBe(stat2);
		await assertReadOnly(harness.client, 'get_measurement_statistics');
	});

	it('resolves the slot from CUSTALL instead of assuming installation order', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'get_measurement_statistics', { channel: 'C3', parameter: 'FREQ' }));
		assertSent(harness.fake, ['PASTAT?', 'PAVA? CUSTALL', 'PAVA? STAT2']);
		expect((result.measurements as Record<string, unknown>[])[0]?.slot).toBe(2);
	});

	it('reports a measurement that is not installed without querying a slot', async () => {
		harness.fake.sent();
		const result = await invoke(harness, 'get_measurement_statistics', { channel: 'C1', parameter: 'FREQ' });
		expect(result.isError).toBe(true);
		assertSent(harness.fake, ['PASTAT?', 'PAVA? CUSTALL']);
		expect(String(payload(result).error)).toMatchRegex(/No custom slot measures FREQ on C1/);
	});

	it('turns statistics on and reads the state back', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'configure_measurement_statistics', { statistics: 'ON' }));
		assertSent(harness.fake, ['PASTAT ON', 'PASTAT?']);
		expect(result.commands).toBeEqual(['PASTAT ON']);
		expect(result.state).toBeEqual({ statistics: 'ON' });
	});

	it('resets the accumulated statistics', async () => {
		harness.fake.sent();
		await invoke(harness, 'configure_measurement_statistics', { statistics: 'RESET' });
		assertSent(harness.fake, ['PASTAT RESET', 'PASTAT?']);
	});

	it('rejects a state the guide does not define without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'configure_measurement_statistics', { statistics: 'CLEAR' });
	});

	it('reads the frequency counter in E notation', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'read_frequency_counter'));
		assertSent(harness.fake, ['CYMT?']);
		expect(result.frequency).toBeEqual({ value: 2.5e7, unit: 'Hz', raw: '2.50E+07Hz' });
		expect(result.raw).toBe('CYMT 2.50E+07Hz');
		expect(result.warnings).toBe(undefined);
		await assertReadOnly(harness.client, 'read_frequency_counter');
	});

	it('reads a counter value whose unit is separated from the number', async () => {
		await withReply(harness, 'CYMT?', 'CYMT 1.00001 kHz', async () => {
			const result = payload(await invoke(harness, 'read_frequency_counter'));
			expect(result.frequency).toBeEqual({ value: 1.00001 * 1e3, unit: 'Hz', raw: '1.00001 kHz' });
		});
	});

	it('reports a signal below 10 Hz as a bound, not as a frequency', async () => {
		await withReply(harness, 'CYMT?', 'CYMT <10Hz', async () => {
			const result = payload(await invoke(harness, 'read_frequency_counter'));
			expect(result.frequency).toBe(undefined);
			expect(result.below).toBeEqual({ value: 10, unit: 'Hz', raw: '10Hz' });
			expect(result.raw).toBe('CYMT <10Hz');
		});
	});

	it('warns that a plain 10Hz reading is the same bound', async () => {
		await withReply(harness, 'CYMT?', '10Hz', async () => {
			const result = payload(await invoke(harness, 'read_frequency_counter'));
			expect(result.frequency).toBeEqual({ value: 10, unit: 'Hz', raw: '10Hz' });
			expect(String((result.warnings as string[])[0])).toMatchRegex(/upper bound/);
		});
	});

	it('installs a phase measurement over a source pair and parses degrees', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'measure_delay', { source_a: 'C2', source_b: 'C4', type: 'PHA' }));
		assertSent(harness.fake, ['MEAD PHA,C2-C4', 'C2-C4:MEAD? PHA']);
		expect(result.commands).toBeEqual(['MEAD PHA,C2-C4']);
		expect(result.sources).toBe('C2-C4');
		expect(result.type).toBe('PHA');
		expect(result.value).toBeEqual({ value: -89.46, unit: 'degree', raw: '-89.46degree' });
		expect(result.raw).toBe('C2-C4:MEAD PHA,-89.46degree');
	});

	it('parses an edge delay as time', async () => {
		const result = payload(await invoke(harness, 'measure_delay', { source_a: 'C1', source_b: 'C2', type: 'SKEW' }));
		expect(result.value).toBeEqual({ value: 1.24e-4, unit: 'S', raw: '1.24E-04S' });
	});

	it('is annotated as mutating because MEAD installs the measurement', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'measure_delay')?.annotations;
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(false);
	});

	it('rejects a pair the guide does not define without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C4', source_b: 'C2', type: 'PHA' });
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C2', source_b: 'C2', type: 'PHA' });
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C1', source_b: 'C2', type: 'DELAY' });
	});

	it('rejects a delay source the scope does not have without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'measure_delay', { source_a: 'C1', source_b: 'C5', type: 'PHA' });
	});

	it('reads the gate switch and reports the two positions as write-only', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'get_measurement_gate'));
		assertSent(harness.fake, ['MEGS?']);
		expect(result.enabled).toBe('ON');
		expect(result.write_only).toBeEqual(['MEGA', 'MEGB']);
		expect(result.gate_a).toBe(undefined);
		expect(result.gate_b).toBe(undefined);
		await assertReadOnly(harness.client, 'get_measurement_gate');
	});

	it('turns the gate on and places gate A before gate B, without querying the command-only positions', async () => {
		harness.fake.sent();
		const result = payload(
			await invoke(harness, 'configure_measurement_gate', { enabled: true, gate_a: '20us', gate_b: '1.68ms' }),
		);
		assertSent(harness.fake, ['MEGS ON', 'MEGA 20us', 'MEGB 1.68ms', 'MEGS?']);
		expect(result.commands).toBeEqual(['MEGS ON', 'MEGA 20us', 'MEGB 1.68ms']);
		expect(result.state).toBeEqual({ enabled: 'ON' });
		expect(String((result.warnings as string[])[0])).toMatchRegex(
			/Gate positions have no query form and cannot be verified/,
		);
	});

	it('reports nothing to check when only the switch is set', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'configure_measurement_gate', { enabled: false }));
		assertSent(harness.fake, ['MEGS OFF', 'MEGS?']);
		expect(result.warnings).toBe(undefined);
	});

	it('takes a gate position without a unit as seconds (pp. 131-132)', async () => {
		harness.fake.sent();
		await invoke(harness, 'configure_measurement_gate', { gate_a: '20' });
		assertSent(harness.fake, ['MEGA 20', 'MEGS?']);
	});

	it('rejects gate A after gate B, and a position with no known unit, without sending anything', async () => {
		await assertInvalidSendsNothing(harness, 'configure_measurement_gate', { gate_a: '2ms', gate_b: '20us' });
		await assertInvalidSendsNothing(harness, 'configure_measurement_gate', { gate_a: '20xs' });
	});

	it('clears every installed measurement', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'clear_measurements'));
		assertSent(harness.fake, ['MEACL']);
		expect(result.commands).toBeEqual(['MEACL']);
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'clear_measurements')?.annotations;
		expect(annotations?.readOnlyHint).toBe(false);
		expect(annotations?.destructiveHint).toBe(true);
	});
});

describe('measure tools without a command header', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'PASTAT?': 'ON',
			'PAVA? CUSTALL': 'CUST1:C2,RISE,4.29E-09S;CUST2:OFF;CUST3:OFF;CUST4:OFF;CUST5:OFF',
			'PAVA? STAT1':
				'STAT1 C2 RISE:cur,4.29E-09S,mean,4.30E-09S,min,4.10E-09S,max,4.50E-09S,std-dev,1.00E-10S,count,42',
		});
	});

	after(() => harness.close());

	it('parses headerless slot and statistics responses', async () => {
		const result = payload(await invoke(harness, 'get_measurement_statistics'));
		expect(result.statistics).toBe('ON');
		expect(result.warnings).toBe(undefined);
		const [first] = result.measurements as Record<string, unknown>[];
		expect(first?.slot).toBe(1);
		expect(first?.source).toBe('C2');
		expect(first?.parameter).toBe('RISE');
		const values = first?.statistics as Record<string, { value?: number }>;
		expect(values.mean?.value).toBe(4.3e-9);
		expect(values.count?.value).toBe(42);
	});
});

describe('measure tools with statistics off', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'PASTAT?': 'PASTAT OFF' });
	});

	after(() => harness.close());

	it('refuses to read a statistic the guide only defines while PASTAT is on', async () => {
		harness.fake.sent();
		const result = await invoke(harness, 'get_measurement_statistics');
		expect(result.isError).toBe(true);
		assertSent(harness.fake, ['PASTAT?']);
		expect(String(payload(result).error)).toMatchRegex(
			/Measurement statistics are off.*configure_measurement_statistics/,
		);
	});
});

describe('measure tools with nothing installed', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'PASTAT?': 'PASTAT ON',
			'PAVA? CUSTALL': 'PAVA CUST1:OFF;CUST2:OFF;CUST3:OFF;CUST4:OFF;CUST5:OFF',
		});
	});

	after(() => harness.close());

	it('warns that no measurement is installed instead of answering empty', async () => {
		harness.fake.sent();
		const result = payload(await invoke(harness, 'get_measurement_statistics'));
		assertSent(harness.fake, ['PASTAT?', 'PAVA? CUSTALL']);
		expect(result.measurements).toBeEqual([]);
		expect(String((result.warnings as string[])[0])).toMatchRegex(/No measurement is installed/);
	});
});

describe('measure tools on a model without the SDS1000X-E measure commands', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(replies, 'SDS2102X');
	});

	after(() => harness.close());

	it('reads parameters and slots, which the guide lists for every family', async () => {
		harness.fake.sent();
		expect(payload(await invoke(harness, 'read_measurement', { channel: 'C1', parameter: 'PKPK' })).raw).toBe(
			replies['C1:PAVA? PKPK'],
		);
		assertSent(harness.fake, ['C1:PAVA? PKPK']);
	});

	it('reads the counter and the delay, which the guide lists for every family', async () => {
		harness.fake.sent();
		expect(payload(await invoke(harness, 'read_frequency_counter')).raw).toBe(replies['CYMT?']);
		expect(payload(await invoke(harness, 'measure_delay', { source_a: 'C1', source_b: 'C2', type: 'SKEW' })).raw).toBe(
			replies['C1-C2:MEAD? SKEW'],
		);
		assertSent(harness.fake, ['CYMT?', 'MEAD SKEW,C1-C2', 'C1-C2:MEAD? SKEW']);
	});

	it('refuses statistics, clearing and the gate before writing anything', async () => {
		harness.fake.sent();
		assertCapabilityError(await invoke(harness, 'get_measurement_statistics'), 'SDS2102X');
		assertCapabilityError(await invoke(harness, 'configure_measurement_statistics', { statistics: 'ON' }), 'SDS2102X');
		assertCapabilityError(await invoke(harness, 'clear_measurements'), 'SDS2102X');
		assertCapabilityError(await invoke(harness, 'get_measurement_gate'), 'SDS2102X');
		assertCapabilityError(await invoke(harness, 'configure_measurement_gate', { enabled: true }), 'SDS2102X');
		assertSent(harness.fake, []);
	});
});
