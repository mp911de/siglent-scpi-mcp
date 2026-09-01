import { ScpiError } from '../../../scpi/connection.ts';

// Table 1 of the guide (pp. 690-691): the fixed-offset WAVEDESC descriptor :WAVeform:PREamble? answers inside an
// IEEE 488.2 block. Every address below is the one that table prints, cross-checked field by field against the byte
// slices of the guide's own "Read Waveform Data Example" (pp. 773-775), which is the only place the guide names both
// the offset and the C type of each field it uses.
export const DESCRIPTOR_BYTES = 346;

const couplings = ['DC', 'AC', 'GND'] as const;
const bandwidths = ['OFF', '20M', '200M'] as const;

// Codes 0-7 are C1-C8 per Table 1; 8 was answered by an F1 trace on an SDS1204X HD. Every other code stays raw.
const waveSources = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'F1'] as const;

// Table 2 (p. 692), the enumerated time base at address 324. Index 9 prints "200E-0", a typo for 200E-9: the column
// runs 100E-9, 200E-9, 500E-9, and the same table in the guide's Python example prints 200e-9 there. The guide notes
// the enumeration itself differs between models, which is why the tool prefers :TIMebase:SCALe? over this table.
const timebases = [
	200e-12, 500e-12, 1e-9, 2e-9, 5e-9, 10e-9, 20e-9, 50e-9, 100e-9, 200e-9, 500e-9, 1e-6, 2e-6, 5e-6, 10e-6, 20e-6,
	50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 100e-3, 200e-3, 500e-3, 1, 2, 5, 10, 20, 50,
	100, 200, 500, 1000,
];

export interface Preamble {
	template: string;
	instrument: string;
	// COMM_TYPE and COMM_ORDER: the sample format in force, which :WAVeform:WIDTh sets.
	width: 'BYTE' | 'WORD';
	byte_order: 'LSB' | 'MSB';
	descriptor_bytes: number;
	transferred_bytes: number;
	points: number;
	first_point: number;
	data_interval: number;
	read_frames: number;
	sum_frames: number;
	vertical_gain: number;
	vertical_offset: number;
	code_per_div: number;
	// The guide's Adc_bit: the width of the transferred sample container, not the converter. A 12-bit scope answers 16.
	adc_bits: number;
	frame_index: number;
	horizontal_interval: number;
	horizontal_offset: number;
	timebase_index: number;
	time_per_div?: number;
	coupling: string;
	probe_attenuation: number;
	bandwidth_limit: string;
	wave_source: string;
}

export function parsePreamble(payload: Buffer): Preamble {
	const name = payload.toString('latin1', 0, 8);
	if (payload.length < DESCRIPTOR_BYTES) {
		throw new ScpiError(
			`The scope returned an invalid waveform descriptor. Expected at least ${DESCRIPTOR_BYTES} bytes but received ${payload.length}.`,
		);
	}
	if (name !== 'WAVEDESC') throw new ScpiError('The scope returned data that is not a supported analog waveform.');
	const short = (address: number) => payload.readInt16LE(address);
	const long = (address: number) => payload.readInt32LE(address);
	const real = (address: number) => payload.readFloatLE(address);
	const string = (address: number, length: number) =>
		payload.toString('latin1', address, address + length).split('\0')[0] ?? '';
	const named = (address: number, names: readonly string[]) => names[short(address)] ?? String(short(address));
	return {
		template: string(16, 16),
		instrument: string(76, 16),
		width: short(32) === 1 ? 'WORD' : 'BYTE',
		byte_order: short(34) === 1 ? 'MSB' : 'LSB',
		descriptor_bytes: long(36),
		transferred_bytes: long(60),
		points: long(116),
		first_point: long(132),
		data_interval: long(136),
		read_frames: long(144),
		sum_frames: long(148),
		vertical_gain: real(156),
		vertical_offset: real(160),
		code_per_div: real(164),
		adc_bits: short(172),
		frame_index: short(174),
		horizontal_interval: real(176),
		horizontal_offset: payload.readDoubleLE(180),
		timebase_index: short(324),
		time_per_div: timebases[short(324)],
		coupling: named(326, couplings),
		probe_attenuation: real(328),
		bandwidth_limit: named(334, bandwidths),
		wave_source: waveSources[short(344)] ?? String(short(344)),
	};
}
