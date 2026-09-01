import { definiteLengthBlock } from '../../src/scpi/codec.ts';

// A second transcription of Table 1 (guide pp. 690-691), independent of the parser it exercises: every address here
// was read off the table, not off src/devices/oscilloscope-scpi/tools/preamble.ts.
export interface Descriptor {
	width: 'BYTE' | 'WORD';
	byte_order: 'LSB' | 'MSB';
	transferred_bytes: number;
	points: number;
	first_point: number;
	data_interval: number;
	read_frames: number;
	sum_frames: number;
	vertical_gain: number;
	vertical_offset: number;
	code_per_div: number;
	adc_bits: number;
	frame_index: number;
	horizontal_interval: number;
	horizontal_offset: number;
	timebase_index: number;
	coupling: number;
	probe_attenuation: number;
	bandwidth_limit: number;
	wave_source: number;
}

// The waveform the guide converts by hand on pp. 694-695: 10 V/div, 14.5 V of offset, 30 codes per division, 20 ns/div
// (Table 2 index 6), 17.2 ns of trigger delay and a 200 ps sampling interval.
export const example: Descriptor = {
	width: 'BYTE',
	byte_order: 'LSB',
	transferred_bytes: 1000,
	points: 1000,
	first_point: 0,
	data_interval: 1,
	read_frames: 1,
	sum_frames: 1,
	vertical_gain: 10,
	vertical_offset: 14.5,
	code_per_div: 30,
	adc_bits: 8,
	frame_index: 1,
	horizontal_interval: 2e-10,
	horizontal_offset: 1.72e-8,
	timebase_index: 6,
	coupling: 0,
	probe_attenuation: 1,
	bandwidth_limit: 0,
	wave_source: 0,
};

// The same signal on a 12-bit scope: the codes are words left aligned in 16 bits, so they and code_per_div are both
// 256 times the 8-bit ones and the volts that come out are identical.
export const example12: Descriptor = { ...example, width: 'WORD', adc_bits: 12, code_per_div: 30 * 256 };

export function wavedesc(fields: Partial<Descriptor> = {}): Buffer {
	const it = { ...example, ...fields };
	const descriptor = Buffer.alloc(346);
	descriptor.write('WAVEDESC', 0, 'latin1');
	descriptor.write('WAVEACE', 16, 'latin1');
	descriptor.writeInt16LE(it.width === 'WORD' ? 1 : 0, 32);
	descriptor.writeInt16LE(it.byte_order === 'MSB' ? 1 : 0, 34);
	descriptor.writeInt32LE(346, 36);
	descriptor.writeInt32LE(it.transferred_bytes, 60);
	descriptor.write('Siglent SDS', 76, 'latin1');
	descriptor.writeInt32LE(it.points, 116);
	descriptor.writeInt32LE(it.first_point, 132);
	descriptor.writeInt32LE(it.data_interval, 136);
	descriptor.writeInt32LE(it.read_frames, 144);
	descriptor.writeInt32LE(it.sum_frames, 148);
	descriptor.writeFloatLE(it.vertical_gain, 156);
	descriptor.writeFloatLE(it.vertical_offset, 160);
	descriptor.writeFloatLE(it.code_per_div, 164);
	descriptor.writeInt16LE(it.adc_bits, 172);
	descriptor.writeInt16LE(it.frame_index, 174);
	descriptor.writeFloatLE(it.horizontal_interval, 176);
	descriptor.writeDoubleLE(it.horizontal_offset, 180);
	descriptor.writeInt16LE(it.timebase_index, 324);
	descriptor.writeInt16LE(it.coupling, 326);
	descriptor.writeFloatLE(it.probe_attenuation, 328);
	descriptor.writeInt16LE(it.bandwidth_limit, 334);
	descriptor.writeInt16LE(it.wave_source, 344);
	return descriptor;
}

// "#9<9-digits>" and, as in the guide's own screen shot of the answer, the two 0A bytes that end it (p. 694).
export const block = (payload: Buffer): Buffer => Buffer.concat([definiteLengthBlock(payload), Buffer.from('\n\n')]);

export const codes = (values: readonly number[], width: 'BYTE' | 'WORD' = 'BYTE'): Buffer => {
	const payload = Buffer.alloc(values.length * (width === 'WORD' ? 2 : 1));
	values.forEach((value, index) => {
		if (width === 'WORD') payload.writeInt16LE(value, index * 2);
		else payload.writeInt8(value, index);
	});
	return payload;
};
