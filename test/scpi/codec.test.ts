import { describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { readAtLeast, readBinary, readText } from '../../src/scpi/codec.ts';

describe('readText', () => {
	it('waits for a complete line', () => {
		expect(readText(Buffer.from('1.00E+'))).toBe(undefined);
	});

	it('strips CR and leading line breaks left by a previous exchange', () => {
		const frame = readText(Buffer.from('\n\n1.00E+01\r\nrest'));
		expect(frame?.payload.toString()).toBe('1.00E+01');
		expect(frame?.end).toBe(12);
	});
});

describe('readAtLeast', () => {
	it('keeps line breaks and every byte that arrived', () => {
		const frame = readAtLeast(4)(Buffer.from([0x0a, 0xff, 0x0d, 0x00, 0x01]));
		expect([...(frame?.payload ?? [])]).toBeEqual([0x0a, 0xff, 0x0d, 0x00, 0x01]);
		expect(frame?.end).toBe(5);
	});

	it('waits for the missing bytes', () => {
		expect(readAtLeast(4)(Buffer.from([0x0a, 0xff, 0x0d]))).toBe(undefined);
	});
});

describe('readBinary', () => {
	const block = Buffer.concat([Buffer.from('DAT2,#9000000005'), Buffer.from([1, 2, 3, 4, 5]), Buffer.from('\n\n')]);

	it('reads an IEEE 488.2 definite length block behind a prefix', () => {
		const frame = readBinary(block);
		expect([...(frame?.payload ?? [])]).toBeEqual([1, 2, 3, 4, 5]);
		expect(frame?.end).toBe(21);
	});

	it('waits until the whole block arrived', () => {
		expect(readBinary(block.subarray(0, 18))).toBe(undefined);
	});

	it('reads a raw bitmap by its declared file size', () => {
		const bmp = Buffer.alloc(30);
		bmp.write('BM');
		bmp.writeUInt32LE(30, 2);
		const frame = readBinary(Buffer.concat([bmp, Buffer.from('\n')]));
		expect(frame?.payload.length).toBe(30);
		expect(frame?.end).toBe(30);
	});
});
