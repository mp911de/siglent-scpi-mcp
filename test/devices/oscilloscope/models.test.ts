import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { describeModel } from '../../../src/devices/oscilloscope/models.ts';
import { parseIdentity } from '../../../src/scpi/instrument.ts';

describe('models', () => {
	it('parses identity', () => {
		expect(parseIdentity('Siglent Technologies,SDS1104X-E,SDS1EBAC0L0098,7.6.1.20').model).toBe('SDS1104X-E');
	});

	it('derives family, dialect and channels', () => {
		const { features, ...capabilities } = describeModel('SDS1104X-E');
		expect(capabilities).toBeEqual({
			family: 'SDS1000X-E',
			dialect: 'legacy',
			guide: 'xe',
			channels: 4,
			spo: true,
			resolution: { bits: 8, codesPerDivision: 25 },
		});
		expect(features.base).toBe('supported');
		expect(describeModel('SDS1202X-E').channels).toBe(2);
		expect(describeModel('SDS2104X Plus').dialect).toBe('scpi');
		expect(describeModel('SDS804X HD').dialect).toBe('scpi');
		expect(describeModel('SDS9999').dialect).toBe('unknown');
	});

	it('separates 8-bit guide models from 12-bit HD models', () => {
		expect(describeModel('SDS2104X').resolution).toBeEqual({ bits: 8, codesPerDivision: 25 });
		expect(describeModel('SDS2354X HD').resolution).toBeEqual({ bits: 12 });
		expect(describeModel('SDS2354X HD').family).toBe('SDS X HD');
		expect(describeModel('SDS2104X Plus').family).toBe('SDS X Plus');
		expect(describeModel('SDS2104X Plus').resolution).toBeEqual({});
		expect(describeModel('SDS9999').resolution).toBeEqual({});
	});
});
