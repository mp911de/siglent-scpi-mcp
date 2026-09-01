import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { asState, parseFields, parseKeyValues, parseQuantity, parseState, stripHeader } from '../../src/scpi/values.ts';

describe('parseQuantity', () => {
	const cases: Array<[string, number, string | undefined]> = [
		['1.00E+01', 10, undefined],
		['1.00E+01V', 10, 'V'],
		['500mV', 0.5, 'V'],
		['1.00GSa/s', 1e9, 'Sa/s'],
		['5.00E+08Sa/s', 5e8, 'Sa/s'],
		['28Mpts', 28e6, 'pts'],
		['7.00E+05pts', 7e5, 'pts'],
		['1600', 1600, undefined],
		['-4.8us', -4.8e-6, 's'],
		['1kHz', 1e3, 'Hz'],
		['500NS', 5e-7, 'S'],
		['-4.8US', -4.8e-6, 'S'],
		['700Kpts', 7e5, 'pts'],
		['2.5MV', 2.5e-3, 'V'],
		['20MHz', 20e6, 'Hz'],
	];
	for (const [raw, value, unit] of cases) {
		it(`parses ${raw}`, () => {
			const parsed = parseQuantity(raw);
			expect(parsed).toBeTruthy();
			if (!parsed) return;
			expect(Math.abs(parsed.value - value) < Math.abs(value) * 1e-9).toBeTruthy();
			expect(parsed.unit).toBe(unit);
		});
	}

	it('rejects non-numeric replies', () => {
		expect(parseQuantity('****')).toBe(undefined);
		expect(parseQuantity('OFF')).toBe(undefined);
		expect(parseQuantity('5XV')).toBe(undefined);
	});
});

describe('parseKeyValues', () => {
	it('pairs comma separated fields', () => {
		expect(parseKeyValues('C1,OFF,C2,ON')).toBeEqual({ C1: 'OFF', C2: 'ON' });
		expect(parseKeyValues('TRSE EDGE,SR,C1,HT,OFF', 1)).toBeEqual({ SR: 'C1', HT: 'OFF' });
	});
});

describe('headers and states', () => {
	it('parses values with CHDR OFF, SHORT and LONG headers', () => {
		for (const raw of ['1.00E+01V', 'C1:VDIV 1.00E+01V', 'C1:VOLT_DIV 1.00E+01V']) {
			expect(parseQuantity(raw)?.value).toBe(10);
			expect(parseQuantity(raw)?.raw).toBe(raw);
		}
		expect(parseQuantity('SARA 1.00 GSa/s')?.value).toBe(1e9);
		expect(stripHeader('DI:SARA 5.00E+05Sa/s')).toBe('5.00E+05Sa/s');
		expect(stripHeader('*OPC 1')).toBe('1');
		expect(stripHeader('1')).toBe('1');
	});

	it('parses state enums case-insensitively and keeps raw otherwise', () => {
		expect(parseState('TRMD AUTO', ['AUTO', 'NORM'])).toBe('AUTO');
		expect(parseState('on', ['ON', 'OFF'])).toBe('ON');
		expect(parseState('****', ['ON', 'OFF'])).toBe(undefined);
		expect(asState('', ['ON', 'OFF'])).toBeEqual({ raw: '' });
	});

	// Hardware answers the SCPI short form: an SDS1204X HD answered HIG where the long form is HIGh.
	it('accepts an unambiguous uppercase-prefix abbreviation of a state', () => {
		expect(parseState('HIG', ['LOW', 'MEDium', 'HIGh'])).toBe('HIGh');
		expect(parseState('med', ['LOW', 'MEDium', 'HIGh'])).toBe('MEDium');
		expect(parseState('HIST', ['HISTogram', 'MIN'])).toBe('HISTogram');
		expect(parseState('CURR', ['ALL', 'CURRent', 'MEAN'])).toBe('CURRent');
		expect(parseState('MAN', ['MANual', 'MANifest'])).toBe(undefined);
		expect(parseState('HI', ['LOW', 'HIGh'])).toBe(undefined);
		expect(parseState('O', ['ON', 'OFF'])).toBe(undefined);
	});

	it('parses key/value lists with headers, repeats, empty and malformed replies', () => {
		expect(parseKeyValues('BWL C1,OFF,C2,ON,C3,OFF,C4,OFF')).toBeEqual({ C1: 'OFF', C2: 'ON', C3: 'OFF', C4: 'OFF' });
		expect(parseKeyValues('C1:PAVA PKPK,1.5V,PKPK,1.6V')).toBeEqual({ PKPK: '1.6V' });
		expect(parseKeyValues('')).toBeEqual({});
		expect(parseKeyValues('****')).toBeEqual({});
		expect(parseKeyValues('FAIL,0,PASS,0,TOTAL')).toBeEqual({ FAIL: '0', PASS: '0' });
		expect(parseFields('C1:CRVA HREL,1.00E-06,2.00E-06, 5.00E-01')).toBeEqual([
			'HREL',
			'1.00E-06',
			'2.00E-06',
			'5.00E-01',
		]);
		expect(parseFields('C1:PAVA PKPK,1.04E+00V', 'PKPK')).toBeEqual(['1.04E+00V']);
		expect(parseFields('1.04E+00V', 'PKPK')).toBeEqual(['1.04E+00V']);
		expect(parseFields('', 'PKPK')).toBeEqual([]);
	});
});
