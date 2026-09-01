import { after, before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { assertSent, payload } from './support/assertions.ts';
import type { Reply } from './support/fake-scope.ts';
import { type Harness, startHarness } from './support/harness.ts';

// PG01-E02C's programming examples (pp. 306-337) drive the scope through whole tasks rather than single commands.
// These walk the same tasks through the MCP tools and assert the traffic of the workflow, which no single-tool test
// sees: the order two tools write in, and the state one leaves behind for the next one to read.
//
// Every scope here is the mock in test/support. Nothing below is evidence about a physical instrument.

const call = (harness: Harness, name: string, args: Record<string, unknown> = {}) =>
	harness.client.callTool({ name, arguments: args });

const ok = async (harness: Harness, name: string, args: Record<string, unknown> = {}) => {
	const result = await call(harness, name, args);
	expect(result.isError).not.toBe(true);
	return payload(result);
};

async function connect(replies: Record<string, Reply>, model = 'SDS1104X-E'): Promise<Harness> {
	const harness = await startHarness({ ...replies, '*IDN?': `Siglent Technologies,${model},SN,7.6.1.20` });
	await call(harness, 'identify');
	harness.fake.sent();
	return harness;
}

describe('workflow: identification and synchronization (pp. 19-20, 330)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ '*OPC?': '1', 'CHDR?': 'CHDR OFF' });
	});

	after(() => harness.close());

	it('identifies the scope, confirms the header mode and synchronizes', async () => {
		const identity = await ok(harness, 'identify');
		const header = await ok(harness, 'get_communication_header');
		await ok(harness, 'mark_operation_complete');
		const complete = await ok(harness, 'wait_until_complete');
		// identify re-applies the header mode before every *IDN?, which is why it is the first line of the workflow.
		assertSent(harness.fake, ['CHDR OFF', '*IDN?', 'CHDR?', '*OPC', '*OPC?']);
		expect(identity.model).toBe('SDS1104X-E');
		expect((identity.capabilities as { dialect: string }).dialect).toBe('legacy');
		expect(header.mode).toBe('OFF');
		expect(complete.completed).toBe(true);
	});
});

describe('workflow: channel and acquisition setup (pp. 24-50)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'C1:ATTN?': 'C1:ATTN 10',
			'C1:VDIV?': 'C1:VDIV 5.00E-01V',
			'C1:OFST?': 'C1:OFST 0.00E+00V',
			'C1:CPL?': 'C1:CPL D1M',
			'C1:SKEW?': 'C1:SKEW 0.00E+00S',
			'C1:UNIT?': 'C1:UNIT V',
			'C1:INVS?': 'C1:INVS OFF',
			'C1:TRA?': 'C1:TRA ON',
			'BWL?': 'BWL C1,OFF,C2,OFF,C3,OFF,C4,OFF',
			'SAST?': 'SAST Trig`d',
			'SARA?': 'SARA 1.00E+09Sa/s',
			'TDIV?': 'TDIV 1.00E-06S',
			'TRDL?': 'TRDL 0.00E+00S',
			'TRMD?': 'TRMD AUTO',
			'ACQW?': 'ACQW SAMPLING',
			'AVGA?': 'AVGA 16',
			'MSIZ?': 'MSIZ 14K',
			'SXSA?': 'SXSA ON',
			'XYDS?': 'XYDS OFF',
		});
	});

	after(() => harness.close());

	it('sets the vertical scale, then the timebase and the sweep, then reads the whole state back', async () => {
		const channel = await ok(harness, 'configure_channel', {
			channel: 'C1',
			volts_per_div: '500mV',
			coupling: 'D1M',
			trace: true,
		});
		const acquisition = await ok(harness, 'configure_acquisition', {
			time_per_div: '1US',
			trigger_mode: 'AUTO',
			action: 'run',
		});
		const state = await ok(harness, 'get_acquisition');
		expect(channel.commands).toBeEqual(['C1:VDIV 500mV', 'C1:CPL D1M', 'C1:TRA ON']);
		expect(acquisition.commands).toBeEqual(['TDIV 1US', 'TRMD AUTO', 'ARM']);
		expect((state.sample_rate as { value: number }).value).toBe(1e9);
		expect((state.time_per_div as { value: number }).value).toBe(1e-6);
		expect(state.trigger_mode).toBe('AUTO');
		// The setup lines of both tools precede every read-back, and the run command is the last line of the workflow.
		const wire = harness.fake.sent();
		expect(wire.slice(0, 3)).toBeEqual(['C1:VDIV 500mV', 'C1:CPL D1M', 'C1:TRA ON']);
		expect(wire.indexOf('TDIV 1US') > wire.indexOf('C1:TRA ON')).toBeTruthy();
		// ARM is the last line configure_acquisition writes and nothing after it writes at all: the run starts on a
		// scope that is already set up, and reading the state back does not disturb it.
		expect(wire.slice(wire.indexOf('ARM') + 1).filter((line) => !line.includes('?'))).toBeEqual([]);
	});
});

describe('workflow: measurement and statistics (pp. 113-132)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'C1:PAVA? PKPK': 'C1:PAVA PKPK,1.04E+00V',
			'PAVA? CUSTALL': 'PAVA CUST1:C1,PKPK,1.04E+00V;CUST2:OFF;CUST3:OFF;CUST4:OFF;CUST5:OFF',
			'PASTAT?': 'PASTAT ON',
			'PAVA? STAT1':
				'PAVA STAT1 C1 PKPK:cur,1.04E+00V,mean,1.03E+00V,min,1.00E+00V,max,1.10E+00V,std-dev,2.00E-02V,count,128',
		});
	});

	after(() => harness.close());

	it('installs a measurement, lists it, turns statistics on and clears the slots', async () => {
		const installed = await ok(harness, 'measure', { channel: 'C1', parameter: 'PKPK' });
		const listed = await ok(harness, 'list_measurements');
		await ok(harness, 'configure_measurement_statistics', { statistics: 'ON' });
		await ok(harness, 'get_measurement_statistics');
		const cleared = await ok(harness, 'clear_measurements');
		expect((installed.value as { value: number }).value).toBe(1.04);
		expect((listed.slots as Array<{ parameter: string }>)[0]?.parameter).toBe('PKPK');
		expect(cleared.commands).toBeEqual(['MEACL']);
		const wire = harness.fake.sent();
		expect(wire.slice(0, 3)).toBeEqual(['PACU PKPK,C1', 'C1:PAVA? PKPK', 'PAVA? CUSTALL']);
		expect(wire.at(-1)).toBe('MEACL');
	});
});

describe('workflow: serial trigger, one protocol at a time (pp. 208-261)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({ 'TRSE?': 'TRSE SERIAL' });
		harness.fake.fallback = (line) => (line.endsWith('?') || line.includes('? ') ? 'ON' : undefined);
	});

	after(() => harness.close());

	const protocols = [
		{ name: 'i2c', prefix: 'TRIIC', args: { condition: 'START' } },
		{ name: 'spi', prefix: 'TRSPI', args: { edge: 'RISING' } },
		{ name: 'uart', prefix: 'TRUART', args: { condition: 'START' } },
		{ name: 'can', prefix: 'TRCAN', args: { condition: 'START' } },
		{ name: 'lin', prefix: 'TRLIN', args: { condition: 'BREAK' } },
	];

	for (const { name, prefix, args } of protocols) {
		it(`selects the serial trigger, then configures and reads back ${name.toUpperCase()} only`, async () => {
			harness.fake.sent();
			await ok(harness, 'configure_trigger_type', { type: 'SERIAL' });
			const configured = await ok(harness, `configure_${name}_trigger`, args);
			await ok(harness, `get_${name}_trigger`);
			const wire = harness.fake.sent();
			expect(wire[0]).toBe('TRSE SERIAL');
			expect(configured.commands).toBeEqual(wire.filter((line) => !line.includes('?')).slice(1));
			// Nothing of another protocol's namespace goes out: the tools share primitives but not mnemonics.
			const foreign = wire.filter((line) => /^TR(IIC|SPI|UART|CAN|LIN)/.test(line) && !line.startsWith(prefix));
			expect(foreign).toBeEqual([]);
		});
	}
});

// The guide's own Python examples read the scaling, then the record, and convert with
// volt = code / 25 * vdiv - ofst, time = -(tdiv * 14 / 2) + index / sara (pp. 331-333).
describe('workflow: waveform transfer (pp. 262-274, 331-333)', () => {
	let harness: Harness;

	const block = (head: string, data: Buffer, declared = data.length): Buffer =>
		Buffer.concat([
			Buffer.from(`${head}:WF ALL,#9${String(declared).padStart(9, '0')}`, 'latin1'),
			data,
			Buffer.from('\n\n', 'latin1'),
		]);

	before(async () => {
		harness = await connect({
			'C1:VDIV?': 'C1:VDIV 5.00E-01V',
			'C1:OFST?': 'C1:OFST -5.00E-01V',
			'TDIV?': 'TDIV 5.00E-09S',
			'SARA?': 'SARA 1.00E+09Sa/s',
			'DI:SARA?': 'DI:SARA 1.00E+09Sa/s',
			'WFSU?': 'WFSU SP,0,NP,1000,FP,0',
			'C1:WF? DAT2': block('C1', Buffer.from([0x02, 0xfc])),
			'D0:WF? DAT2': block('D0', Buffer.from([0b00000101]), 8),
		});
	});

	after(() => harness.close());

	it('plans the transfer, reads the analog record and converts it the way the guide example does', async () => {
		const result = await ok(harness, 'get_waveform', { source: 'C1' });
		assertSent(harness.fake, [
			'C1:VDIV?',
			'C1:OFST?',
			'TDIV?',
			'SARA?',
			'WFSU SP,0,NP,1000,FP,0',
			'WFSU?',
			'C1:WF? DAT2',
		]);
		const waveform = result.waveform as { time: number[]; voltage: number[] };
		expect(waveform.voltage).toBeEqual([0.54, 0.44]);
		expect(waveform.time).toBeEqual([-3.5e-8, -3.4e-8]);
	});

	it('reads the digital record as bits, LSB first, off the digital sample rate', async () => {
		harness.fake.sent();
		const result = await ok(harness, 'get_waveform', { source: 'D0' });
		assertSent(harness.fake, ['TDIV?', 'DI:SARA?', 'WFSU SP,0,NP,1000,FP,0', 'WFSU?', 'D0:WF? DAT2']);
		expect((result.waveform as { state: number[] }).state).toBeEqual([1, 0, 1, 0, 0, 0, 0, 0]);
	});
});

describe('workflow: screen dump and panel setup (pp. 146-172, 334)', () => {
	let harness: Harness;

	const screen = (() => {
		const image = Buffer.alloc(54, 0x20);
		image.write('BM', 0, 'ascii');
		image.writeUInt32LE(image.length, 2);
		image.writeUInt32LE(40, 14);
		return image;
	})();
	const xml = '<setup><TDIV>1US</TDIV></setup>';
	const setup = Buffer.from(`#9${String(xml.length).padStart(9, '0')}${xml}`, 'latin1');

	before(async () => {
		harness = await connect({ SCDP: screen, 'PNSU?': setup, '*OPC?': '1', 'CHDR?': 'CHDR OFF' });
	});

	after(() => harness.close());

	it('dumps the screen, captures the panel setup and restores exactly what it captured', async () => {
		const shot = await ok(harness, 'capture_screenshot');
		const captured = await ok(harness, 'capture_panel_setup');
		const { id } = captured.setup as { id: string; bytes: number };
		const restored = await ok(harness, 'restore_panel_setup', { setup_id: id, confirm_restore: true });
		assertSent(harness.fake, ['SCDP', 'PNSU?', `PNSU ${setup.toString('latin1')}`, '*OPC?', 'CHDR OFF', '*IDN?']);
		expect((shot.screenshot as { bytes: number }).bytes).toBe(screen.length);
		expect((captured.setup as { bytes: number }).bytes).toBe(xml.length);
		expect((restored.setup as { id: string }).id).toBe(id);
	});
});

describe('workflow: pass/fail test (pp. 133-145)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'PFSC?': 'PF_SOURCE C1',
			'PFST?': 'PF_SET XMASK,0.40,YMASK,0.52',
			'PFBF?': 'PF_BUFFER OFF',
			'PFEN?': 'PF_ENABLE ON',
			'PFDS?': 'PF_DISPLAY ON',
			'PFFS?': 'PF_FAIL_STOP OFF',
			'PFOP?': 'PF_OPERATION ON',
			'PFDD?': 'PF_DATADIS FAIL,2,PASS,3,TOTAL,5',
		});
	});

	after(() => harness.close());

	it('builds the mask, starts the test, reads the counts and resets them', async () => {
		const mask = await ok(harness, 'configure_pass_fail_mask', {
			source: 'C1',
			x_mask: 0.4,
			y_mask: 0.52,
			create_mask: true,
			confirm_replace_mask: true,
		});
		const started = await ok(harness, 'configure_pass_fail', { enabled: true, running: true, display: true });
		const counts = await ok(harness, 'get_pass_fail');
		const reset = await ok(harness, 'reset_pass_fail_statistics');
		const wire = harness.fake.sent();
		expect((mask.commands as string[]).indexOf('PFCM') === (mask.commands as string[]).length - 1).toBeTruthy();
		expect(wire.indexOf('PFCM') < wire.indexOf('PFOP ON')).toBeTruthy();
		expect(started.commands).toBeEqual(['PFEN ON', 'PFDS ON', 'PFOP ON']);
		expect([counts.fail, counts.pass, counts.total]).toBeEqual([2, 3, 5]);
		expect(reset.commands).toBeEqual(['PACL']);
		expect(wire.at(-1)).toBe('PACL');
	});
});

describe('workflow: reference waveform (pp. 153-163)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect({
			'REFLA?': 'REFLA REFA',
			'REFSR?': 'REFSR C1',
			'REFDS?': 'REFDS ON',
			'REFSC?': 'REFSC 1.00E-01V',
			'REFPO?': 'REFPO 2.00E-01V',
		});
	});

	after(() => harness.close());

	it('saves a channel into a reference, reads it back and closes the function', async () => {
		const saved = await ok(harness, 'configure_reference', {
			location: 'REFA',
			source: 'C1',
			save: true,
			confirm_overwrite_reference: true,
			display: true,
		});
		const state = await ok(harness, 'get_reference');
		const closed = await ok(harness, 'close_reference');
		expect(saved.commands).toBeEqual(['REFLA REFA', 'REFSR C1', 'REFSA', 'REFDS ON']);
		expect(state.source).toBe('C1');
		expect(closed.commands).toBeEqual(['REFCL']);
		expect(harness.fake.sent().at(-1)).toBe('REFCL');
	});
});

describe('workflow: waveform generator (pp. 275-282)', () => {
	let harness: Harness;

	before(async () => {
		harness = await connect(
			{
				'PROD? MODEL': 'PROD MODEL,SDS2000X',
				'PROD? BAND': 'PROD BAND,25MHz',
				'STL? DEBUG': 'STL M0,SINE,M1,NOISE,M2,CARDIAC,M3,GAUS_PULSE,M4,EXP_RISE,M5,EXP_FALL',
				'STL? RELEASE': 'STL M6,EMPTY,M7,EMPTY,M8,EMPTY,M9,EMPTY',
				'WGEN? ALL': 'WGEN OUTP,OFF,WVTP,SINE,FREQ,1000HZ,AMPL,2V,OFST,0V,LOAD,HZ',
				'WGEN? OUTP': 'WGEN OUTP,OFF',
			},
			'SDS2104X',
		);
	});

	after(() => harness.close());

	it('reads the generator, shapes the waveform and only then enables the output', async () => {
		const state = await ok(harness, 'get_waveform_generator', { waveforms: [] });
		const shaped = await ok(harness, 'configure_waveform_generator', {
			waveform: { type: 'SINE', frequency: '1000Hz', amplitude: '2V' },
		});
		const enabled = await ok(harness, 'configure_waveform_generator', {
			output: true,
			confirm_output_enable: true,
		});
		expect((state.state as { output: boolean }).output).toBe(false);
		expect((state.product as { model: string }).model).toBe('SDS2000X');
		// The AWG option is never inferred from the model name, so every call to this family carries the warning.
		expect((state.warnings as string[]).some((warning) => /awg .* is unknown/.test(warning))).toBeTruthy();
		expect(shaped.commands).toBeEqual(['WGEN WVTP,SINE,FREQ,1000Hz,AMPL,2V']);
		expect(enabled.commands).toBeEqual(['WGEN OUTP,ON']);
		const wire = harness.fake.sent();
		expect(wire.indexOf('WGEN WVTP,SINE,FREQ,1000Hz,AMPL,2V') < wire.indexOf('WGEN OUTP,ON')).toBeTruthy();
	});
});
