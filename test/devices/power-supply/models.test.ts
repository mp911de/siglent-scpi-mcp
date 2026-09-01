import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { describeSupply } from '../../../src/devices/power-supply/models.ts';

describe('describeSupply', () => {
	it('maps SPD1168X and SPD1305X to the SPD1000X set with their rated outputs', () => {
		const spd1168x = describeSupply('SPD1168X');
		expect(spd1168x.family).toBe('SPD1000X');
		expect(spd1168x.set).toBe('SPD1000X');
		expect(spd1168x.channels).toBe(1);
		expect(spd1168x.rating).toBeEqual({ volts: 16, amps: 8 });
		expect(spd1168x.features.ovpOcp).toBe('supported');
		expect(spd1168x.features.timer).toBe('supported');
		expect(spd1168x.features.lanConfig).toBe('supported');
		expect(spd1168x.features.track).toBe('unsupported');
		expect(spd1168x.features.fixedThirdChannel).toBe('unsupported');
		expect(describeSupply('SPD1305X').rating).toBeEqual({ volts: 30, amps: 5 });
	});

	it('maps the SPD3303 models to the SPD3303 set, with a rating for the C only', () => {
		for (const model of ['SPD3303X', 'SPD3303X-E', 'SPD3303C']) {
			const capabilities = describeSupply(model);
			expect(capabilities.family).toBe('SPD3303');
			expect(capabilities.set).toBe('SPD3303');
			expect(capabilities.channels).toBe(2);
			expect(capabilities.features.track).toBe('supported');
			expect(capabilities.features.fixedThirdChannel).toBe('supported');
			expect(capabilities.features.ovpOcp).toBe('unsupported');
			expect(capabilities.features.timer).toBe('unsupported');
			expect(capabilities.features.powerMeasure).toBe('unsupported');
			expect(capabilities.features.deleteSavedStates).toBe('unsupported');
			expect(capabilities.features.lanConfig).toBe('unsupported');
		}
		expect(describeSupply('SPD3303C').rating).toBeEqual({ volts: 32, amps: 3.2 });
		expect(describeSupply('SPD3303X').rating).toBe(undefined);
	});

	it('reports an unknown SPD model with every feature unknown and no channel count', () => {
		const unknown = describeSupply('SPD4000');
		expect(unknown.family).toBe('unknown');
		expect(unknown.set).toBe(undefined);
		expect(unknown.channels).toBe(undefined);
		expect(unknown.rating).toBe(undefined);
		for (const support of Object.values(unknown.features)) expect(support).toBe('unknown');
	});
});
