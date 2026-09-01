import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import type { ToolError } from '../../../../src/tools/define.ts';
import {
	assertCapabilityError,
	assertInvalidSendsNothing,
	assertReadOnly,
	assertSent,
	payload,
} from '../../../support/assertions.ts';
import type { Reply } from '../../../support/fake-scope.ts';
import { type Harness, startHarness, text } from '../../../support/harness.ts';

const replies = {
	'TRMD?': 'TRMD AUTO',
	'TRWI?': 'TRWI 2.00E+00V',
	'TRSE?': 'TRSE EDGE,SR,C1,HT,OFF',
	'TRPA?': 'TRPA C1,X,C2,L,C3,L,C4,X,STATE,AND',
	'C1:TRCP?': 'C1:TRCP DC',
	'C1:TRLV?': 'C1:TRLV 5.20E-02V',
	'C1:TRLV2?': 'C1:TRLV2 1.00E-02V',
	'C1:TRSL?': 'C1:TRSL POS',
	'EX:TRCP?': 'EX:TRCP AC',
	'EX:TRLV?': 'EX:TRLV 1.00E+00V',
	'EX:TRSL?': 'EX:TRSL NEG',
};

const readback = ['TRMD?', 'TRWI?', 'TRSE?', 'TRPA?', 'C1:TRCP?', 'C1:TRLV?', 'C1:TRLV2?', 'C1:TRSL?'];

const currentPattern = {
	c1: 'X',
	c2: 'L',
	c3: 'L',
	c4: 'X',
	condition: 'AND',
	raw: 'TRPA C1,X,C2,L,C3,L,C4,X,STATE,AND',
};

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

type Result = Parameters<typeof payload>[0];

const warnings = (result: Result) => (payload(result).warnings ?? []) as string[];

const failure = (result: Result) => JSON.parse(text(result)) as ToolError;

async function connect(extra: Record<string, Reply> = {}, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, ...extra, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

const selects = (harness: Harness, raw: string) => harness.fake.replies.set('TRSE?', raw);

const asSlew = (harness: Harness) => harness.fake.replies.set('TRSE?', 'TRSE SLEW,SR,C1,HT,IS,HV,1.00E-06S');
const asEdge = (harness: Harness) => harness.fake.replies.set('TRSE?', replies['TRSE?']);

describe('trigger tools', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('reads sweep mode, trigger condition, coupling, both levels and slope of a channel', async () => {
		const state = payload(await call(harness, 'get_trigger', { source: 'C1' }));
		expect(state).toBeEqual({
			source: 'C1',
			trigger_mode: 'AUTO',
			window_height: { value: 2, unit: 'V', raw: 'TRWI 2.00E+00V' },
			selected: { type: 'EDGE', source: 'C1', hold_type: 'OFF', raw: 'TRSE EDGE,SR,C1,HT,OFF' },
			pattern: currentPattern,
			coupling: 'DC',
			level: { value: 0.052, unit: 'V', raw: 'C1:TRLV 5.20E-02V' },
			level_low: { value: 0.01, unit: 'V', raw: 'C1:TRLV2 1.00E-02V' },
			slope: 'POS',
		});
		assertSent(harness.fake, readback);
		await assertReadOnly(harness.client, 'get_trigger');
	});

	it('never asks an external source for the second level the guide gives analog channels only', async () => {
		const state = payload(await call(harness, 'get_trigger', { source: 'EX' }));
		expect(state.level_low).toBe(undefined);
		assertSent(harness.fake, ['TRMD?', 'TRWI?', 'TRSE?', 'TRPA?', 'EX:TRCP?', 'EX:TRLV?', 'EX:TRSL?']);
	});

	it('sends coupling, level and slope in guide order and reads the state back', async () => {
		const result = payload(
			await call(harness, 'configure_trigger', { source: 'C1', coupling: 'DC', level: '52mV', slope: 'POS' }),
		);
		expect(result.commands).toBeEqual(['C1:TRCP DC', 'C1:TRLV 52mV', 'C1:TRSL POS']);
		assertSent(harness.fake, ['C1:TRCP DC', 'C1:TRLV 52mV', 'C1:TRSL POS', 'C1:TRCP?', 'C1:TRLV?', 'C1:TRSL?']);
		expect(result.warnings).toBe(undefined);
	});

	it('reports a level the scope adjusted to the range of the source', async () => {
		const result = await call(harness, 'configure_trigger', { source: 'C1', level: '10V' });
		assertSent(harness.fake, ['C1:TRLV 10V', 'C1:TRLV?']);
		expect(
			warnings(result).some((warning) =>
				/level was set to "10V" but the scope reports 0.052 because a level outside the range of the source is adjusted by the scope/.test(
					warning,
				),
			),
		).toBeTruthy();
	});

	it('refuses a second level while the trigger type has only one, after only having asked for the type', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_trigger', { source: 'C1', level_low: '5mV' });
		expect(result.isError).toBe(true);
		expect(failure(result).error).toMatchRegex(/level_low requires a dual-level trigger type/);
		assertSent(harness.fake, ['TRSE?']);
	});

	it('refuses the WINDOW slope while the trigger type is not edge', async () => {
		asSlew(harness);
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_trigger', { source: 'C1', slope: 'WINDOW' });
			expect(failure(result).error).toMatchRegex(
				/Window slope requires an Edge trigger, but the current trigger type is SLEW/,
			);
			assertSent(harness.fake, ['TRSE?']);
		} finally {
			asEdge(harness);
		}
	});

	it('checks a lone second level against the level the scope holds, and sends it when it is below', async () => {
		asSlew(harness);
		try {
			harness.fake.sent();
			const refused = await call(harness, 'configure_trigger', { source: 'C1', level_low: '100mV' });
			expect(failure(refused).error).toMatchRegex(/level_low 100mV is not below the current trigger level/);
			assertSent(harness.fake, ['TRSE?', 'C1:TRLV?']);

			const result = payload(await call(harness, 'configure_trigger', { source: 'C1', level_low: '10mV' }));
			expect(result.commands).toBeEqual(['C1:TRLV2 10mV']);
			assertSent(harness.fake, ['TRSE?', 'C1:TRLV?', 'C1:TRLV2 10mV', 'C1:TRLV2?']);
			expect(result.warnings).toBe(undefined);
		} finally {
			asEdge(harness);
		}
	});

	it('sends both levels without asking, high first', async () => {
		harness.fake.sent();
		asSlew(harness);
		try {
			const result = payload(
				await call(harness, 'configure_trigger', { source: 'C1', level: '52mV', level_low: '10mV' }),
			);
			expect(result.commands).toBeEqual(['C1:TRLV 52mV', 'C1:TRLV2 10mV']);
			assertSent(harness.fake, ['TRSE?', 'C1:TRLV 52mV', 'C1:TRLV2 10mV', 'C1:TRLV?', 'C1:TRLV2?']);
		} finally {
			asEdge(harness);
		}
	});

	it('centers the level on the source the scope triggers on', async () => {
		harness.fake.sent();
		const result = payload(await call(harness, 'configure_trigger', { source: 'C1', center_level: true }));
		expect(result.commands).toBeEqual(['SET50']);
		assertSent(harness.fake, ['TRSE?', 'SET50', 'C1:TRLV?', 'C1:TRLV2?']);
	});

	it('reports that centering has no effect on a dual-level trigger type', async () => {
		asSlew(harness);
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_trigger', { source: 'C1', center_level: true });
			assertSent(harness.fake, ['TRSE?', 'SET50', 'C1:TRLV?', 'C1:TRLV2?']);
			expect(
				warnings(result).some((warning) => /center_level has no effect while the trigger type is SLEW/.test(warning)),
			).toBeTruthy();
		} finally {
			asEdge(harness);
		}
	});

	it('refuses to center a source the scope does not trigger on', async () => {
		harness.fake.sent();
		const result = await call(harness, 'configure_trigger', { source: 'C2', center_level: true });
		expect(failure(result).error).toMatchRegex(/center_level applies to the active trigger source C1, not C2/);
		assertSent(harness.fake, ['TRSE?']);
	});

	it('sends the request unchecked and says so when the trigger type does not parse', async () => {
		harness.fake.replies.set('TRSE?', 'TRSE ???');
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_trigger', { source: 'C1', center_level: true });
			assertSent(harness.fake, ['TRSE?', 'SET50', 'C1:TRLV?', 'C1:TRLV2?']);
			expect(warnings(result).some((warning) => /trigger type response.*sent unchecked/i.test(warning))).toBeTruthy();
		} finally {
			asEdge(harness);
		}
	});

	it('sends nothing for a level the scope cannot take, a source-less request or a contradictory one', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger', { level: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'LINE', level: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C1', level: '1A' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'EX', level_low: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C1', level: '1V', level_low: '2V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C1', level: '1V', center_level: true });
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C1' });
	});

	it('annotates the configuration as mutating, not destructive', async () => {
		const { tools } = await harness.client.listTools();
		const annotations = tools.find((tool) => tool.name === 'configure_trigger')?.annotations;
		expect(annotations).toBeEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});
});

describe('trigger tools on a two-channel model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({}, 'SDS1102X-E');
	});

	after(() => harness.close());

	it('refuses a source the model does not have', async () => {
		assertCapabilityError(await call(harness, 'get_trigger', { source: 'C4' }), 'SDS1102X-E');
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C4', level: '1V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', source: 'C4' });
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { c4: 'H', condition: 'AND' });
	});

	it('selects the serial trigger of an SDS1000X-E with the bare TRSE the serial chapter documents', async () => {
		selects(harness, 'TRSE SERIAL');
		const result = payload(await call(harness, 'configure_trigger_type', { type: 'SERIAL' }));
		expect(result.commands).toBeEqual(['TRSE SERIAL']);
		expect(result.state).toBeEqual({ type: 'SERIAL', raw: 'TRSE SERIAL' });
		assertSent(harness.fake, ['TRSE SERIAL', 'TRSE?']);
	});
});

describe('trigger tools on a newer-dialect model', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({}, 'SDS2504X HD');
	});

	after(() => harness.close());

	it('never sends the legacy trigger commands', async () => {
		assertCapabilityError(await call(harness, 'get_trigger', { source: 'C1' }), 'SDS2504X HD');
		await assertInvalidSendsNothing(harness, 'configure_trigger', { source: 'C1', coupling: 'AC' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { c1: 'H', condition: 'AND' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_window', { window_height: '2V' });
	});
});

describe('trigger type selection', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('sends the hold criteria of the guide examples and reads the condition back', async () => {
		selects(harness, 'TRSE EDGE,SR,C1,HT,TI,HV,1.43E-06S');
		const edge = payload(
			await call(harness, 'configure_trigger_type', {
				type: 'EDGE',
				source: 'C1',
				hold_type: 'TI',
				hold_value: '1.43US',
			}),
		);
		expect(edge.commands).toBeEqual(['TRSE EDGE,SR,C1,HT,TI,HV,1.43US']);
		assertSent(harness.fake, ['TRSE EDGE,SR,C1,HT,TI,HV,1.43US', 'TRSE?']);
		expect(edge.state).toBeEqual({
			type: 'EDGE',
			source: 'C1',
			hold_type: 'TI',
			hold_value: '1.43E-06S',
			raw: 'TRSE EDGE,SR,C1,HT,TI,HV,1.43E-06S',
		});
		expect(edge.warnings).toBe(undefined);

		selects(harness, 'TRSE GLIT,SR,C2,HT,P2,HV,5.00E-09S,HV2,1.00E-06S');
		const glitch = payload(
			await call(harness, 'configure_trigger_type', {
				type: 'GLIT',
				source: 'C2',
				hold_type: 'P2',
				hold_value: '5NS',
				hold_value2: '1US',
			}),
		);
		expect(glitch.commands).toBeEqual(['TRSE GLIT,SR,C2,HT,P2,HV,5NS,HV2,1US']);
		expect(glitch.warnings).toBe(undefined);

		selects(harness, 'TRSE DROP,SR,C4,HT,TI,HV,2.80E-03S');
		const dropout = payload(
			await call(harness, 'configure_trigger_type', {
				type: 'DROP',
				source: 'C4',
				hold_type: 'TI',
				hold_value: '2.8MS',
			}),
		);
		expect(dropout.commands).toBeEqual(['TRSE DROP,SR,C4,HT,TI,HV,2.8MS']);
		expect(dropout.warnings).toBe(undefined);
	});

	it('sends the TV criteria in guide order', async () => {
		harness.fake.sent();
		selects(harness, 'TRSE TV,SR,C1,STAN,PAL,SYNC,SELECT,LINE,300,FLD,2');
		const result = payload(
			await call(harness, 'configure_trigger_type', {
				type: 'TV',
				source: 'C1',
				standard: 'PAL',
				sync: 'SELECT',
				line: 300,
				field: 2,
			}),
		);
		expect(result.commands).toBeEqual(['TRSE TV,SR,C1,STAN,PAL,SYNC,SELECT,LINE,300,FLD,2']);
		assertSent(harness.fake, ['TRSE TV,SR,C1,STAN,PAL,SYNC,SELECT,LINE,300,FLD,2', 'TRSE?']);
		expect(result.warnings).toBe(undefined);
	});

	it('sends the line of a custom TV standard unchecked and says so', async () => {
		selects(harness, 'TRSE TV,SR,C1,STAN,CUST,SYNC,SELECT,LINE,900');
		const result = await call(harness, 'configure_trigger_type', {
			type: 'TV',
			source: 'C1',
			standard: 'CUST',
			sync: 'SELECT',
			line: 900,
		});
		expect(warnings(result).some((warning) => /line count.*line was sent unchecked/.test(warning))).toBeTruthy();
	});

	it('reports a criterion the scope did not take', async () => {
		selects(harness, 'TRSE EDGE,SR,C1,HT,OFF');
		const result = await call(harness, 'configure_trigger_type', {
			type: 'EDGE',
			source: 'C1',
			hold_type: 'TI',
			hold_value: '100NS',
		});
		expect(
			warnings(result).some((warning) => /hold_type was set to "TI".*scope reports "OFF"/.test(warning)),
		).toBeTruthy();
	});

	it('sends nothing for a TV trigger on a source the guide reserves for the edge trigger', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'TV', source: 'EX' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'TV',
			source: 'LINE',
			standard: 'PAL',
			sync: 'ANY',
		});
	});

	it('sends nothing for criteria that do not belong to the trigger type', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'SERIAL', source: 'C1' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', standard: 'PAL' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'TV', source: 'C1', hold_type: 'TI' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'SLEW', source: 'LINE' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', hold_type: 'PS' });
	});

	it('sends nothing for hold values outside the range of the type or a range without two ordered bounds', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', hold_value: '10NS' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'GLIT', hold_value: '1NS' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'GLIT', hold_value: '5S' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'EDGE', hold_value: '1MV' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'GLIT',
			hold_type: 'P2',
			hold_value: '5NS',
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'GLIT',
			hold_type: 'P2',
			hold_value: '1US',
			hold_value2: '5NS',
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'GLIT',
			hold_type: 'PS',
			hold_value: '5NS',
			hold_value2: '1US',
		});
	});

	it('sends nothing for a line or field the standard does not have', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'TV',
			standard: 'NTSC',
			line: 300,
			field: 2,
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', {
			type: 'TV',
			standard: '720P/50',
			line: 300,
			field: 1,
		});
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'TV', standard: 'PAL', field: 2 });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'TV', line: 300 });
		await assertInvalidSendsNothing(harness, 'configure_trigger_type', { type: 'PATTERN', source: 'C1' });
	});
});

describe('pattern trigger', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('sends the channel statuses and the condition in one command and reads them back', async () => {
		const result = payload(await call(harness, 'configure_pattern_trigger', { c2: 'L', c3: 'L', condition: 'AND' }));
		expect(result.commands).toBeEqual(['TRPA C2,L,C3,L,STATE,AND']);
		assertSent(harness.fake, ['TRPA C2,L,C3,L,STATE,AND', 'TRPA?']);
		expect(result.state).toBeEqual(currentPattern);
		expect(result.warnings).toBe(undefined);
	});

	it('reports a status the scope did not take, which happens while the channel is off', async () => {
		const result = await call(harness, 'configure_pattern_trigger', { c1: 'H', condition: 'AND' });
		expect(
			warnings(result).some((warning) =>
				/c1 was set to "H".*scope reports "X".*source status applies only while the channel is enabled/i.test(warning),
			),
		).toBeTruthy();
	});

	it('refuses a pattern that would leave the scope ignoring every channel, after only having read it', async () => {
		harness.fake.replies.set('TRPA?', 'TRPA C1,X,C2,X,C3,X,C4,X,STATE,AND');
		try {
			harness.fake.sent();
			const result = await call(harness, 'configure_pattern_trigger', { c1: 'X', condition: 'OR' });
			expect(failure(result).error).toMatchRegex(/Every channel would be ignored/);
			assertSent(harness.fake, ['TRPA?']);

			const result2 = payload(await call(harness, 'configure_pattern_trigger', { c1: 'H', condition: 'OR' }));
			expect(result2.commands).toBeEqual(['TRPA C1,H,STATE,OR']);
			assertSent(harness.fake, ['TRPA C1,H,STATE,OR', 'TRPA?']);
		} finally {
			harness.fake.replies.set('TRPA?', replies['TRPA?']);
		}
	});

	it('sends nothing without a channel, without a condition or for the fourth operator the guide duplicates', async () => {
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { condition: 'AND' });
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { c1: 'H' });
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { c1: 'H', condition: 'NOR' });
		await assertInvalidSendsNothing(harness, 'configure_pattern_trigger', { c1: 'Y', condition: 'AND' });
	});
});

describe('trigger window', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect();
	});

	after(() => harness.close());

	it('sets the relative window height and reads it back', async () => {
		const result = payload(await call(harness, 'configure_trigger_window', { window_height: '2V' }));
		expect(result.commands).toBeEqual(['TRWI 2V']);
		assertSent(harness.fake, ['TRWI 2V', 'TRWI?']);
		expect(result.state).toBeEqual({ window_height: { value: 2, unit: 'V', raw: 'TRWI 2.00E+00V' } });
		expect(result.warnings).toBe(undefined);
	});

	it('reports a height the scope did not take', async () => {
		const result = await call(harness, 'configure_trigger_window', { window_height: '9V' });
		expect(
			warnings(result).some((warning) =>
				/window_height was set to "9V".*scope reports 2.*setting applies only while the trigger window type is Relative/i.test(
					warning,
				),
			),
		).toBeTruthy();
	});

	it('sends nothing for a negative height, a height in the wrong unit or no height at all', async () => {
		await assertInvalidSendsNothing(harness, 'configure_trigger_window', { window_height: '-1V' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_window', { window_height: '1A' });
		await assertInvalidSendsNothing(harness, 'configure_trigger_window', {});
	});

	it('annotates the new trigger tools as mutating', async () => {
		const { tools } = await harness.client.listTools();
		for (const name of ['configure_trigger_type', 'configure_pattern_trigger', 'configure_trigger_window']) {
			expect(tools.find((tool) => tool.name === name)?.annotations).toBeEqual({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		}
	});
});
