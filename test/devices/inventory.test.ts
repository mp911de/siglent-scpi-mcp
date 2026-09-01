import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { applyInventory, detectKind, resolveFamily } from '../../src/devices/families.ts';
import { loadInventory } from '../../src/devices/inventory.ts';
import { describeModel } from '../../src/devices/oscilloscope/models.ts';

describe('inventory overlay', () => {
	after(() => applyInventory({}));

	it('extends a known family with exact models and patterns', () => {
		const warnings = applyInventory({ 'SDS X HD': { models: ['SDS-HD-PROTO', { pattern: '^SDS8\\d{2}QX HD' }] } });
		expect(warnings).toBeEqual([]);
		expect(resolveFamily('SDS-HD-PROTO')?.family).toBe('SDS X HD');
		expect(resolveFamily('SDS812QX HD')?.family).toBe('SDS X HD');
		expect(describeModel('SDS-HD-PROTO').resolution).toBeEqual({ bits: 12 });
		expect(detectKind('SDS-HD-PROTO')).toBe('oscilloscope');
		expect(resolveFamily('SDS2354X HD')?.family).toBe('SDS X HD');
	});

	it('defines a new family with a full declaration', () => {
		const warnings = applyInventory({ SPD1000X: { kind: 'power-supply', models: ['SPD1168X'] } });
		expect(warnings).toBeEqual([]);
		expect(resolveFamily('SPD1168X')?.family).toBe('SPD1000X');
		expect(detectKind('SPD1168X')).toBe('power-supply');
	});

	it('lets an exact model string win over an earlier pattern', () => {
		applyInventory({
			'Wide net': { kind: 'oscilloscope', models: [{ pattern: '^SDS1\\d{3}X-E$' }] },
			'Lab special': { kind: 'oscilloscope', dialect: 'legacy', models: ['SDS1104X-E'] },
		});
		expect(resolveFamily('SDS1104X-E')?.family).toBe('Lab special');
		expect(resolveFamily('SDS1204X-E')?.family).toBe('Wide net');
	});

	it('lets an overlay pattern win over a built-in pattern', () => {
		applyInventory({ 'HD lab': { kind: 'oscilloscope', models: [{ pattern: '^SDS2354X HD$' }] } });
		expect(resolveFamily('SDS2354X HD')?.family).toBe('HD lab');
		expect(resolveFamily('SDS3054X HD')?.family).toBe('SDS X HD');
	});

	it('warns about a family key that shadows nothing and omits a declaration', () => {
		const warnings = applyInventory({ 'SDS X HDD': { models: ['SDS1104X-Q'] } });
		expect(warnings.length).toBe(1);
		expect(warnings[0] ?? '').toMatchRegex(/SDS X HDD.*no built-in family.*no kind/);
		expect(resolveFamily('SDS1104X-Q')).toBe(undefined);
	});

	it('reverts to the built-in table when the overlay is empty', () => {
		applyInventory({ SPD1000X: { models: ['SPD9999'] } });
		expect(resolveFamily('SPD9999')?.family).toBe('SPD1000X');
		applyInventory({});
		expect(resolveFamily('SPD9999')).toBe(undefined);
		expect(detectKind('SPD9999')).toBe('power-supply');
	});

	const invalid: Array<[string, unknown]> = [
		['a capability without a kind', { 'New family': { models: ['A'], dialect: 'legacy' } }],
		['an unknown kind', { 'New family': { kind: 'toaster', models: ['A'] } }],
		['an empty model list', { 'SDS X HD': { models: [] } }],
		['a malformed pattern', { 'SDS X HD': { models: [{ pattern: '(' }] } }],
		['a non-object', ['SDS X HD']],
	];
	for (const [what, overlay] of invalid) {
		it(`rejects ${what}`, () => {
			expect(() => applyInventory(overlay)).toThrow();
		});
	}
});

describe('inventory file loading', () => {
	it('rejects a file that does not parse', () => {
		const dir = mkdtempSync(join(tmpdir(), 'inventory-'));
		const file = join(dir, 'inventory.json');
		writeFileSync(file, '{ not json');
		expect(() => loadInventory(file)).toThrow();
	});

	it('rejects a shape the inventory schema refuses', () => {
		const dir = mkdtempSync(join(tmpdir(), 'inventory-'));
		const file = join(dir, 'inventory.json');
		writeFileSync(file, JSON.stringify({ 'New family': { models: ['A'], dialect: 'legacy' } }));
		expect(() => loadInventory(file)).toThrow();
	});
});
