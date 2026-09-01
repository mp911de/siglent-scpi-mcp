import { stderr } from 'node:process';
import { describe, it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { expect } from '@assertive-ts/core';
import { renderLog, status } from '../src/console.ts';

const line = (level: number, msg: string, extra: object = {}): string => JSON.stringify({ level, msg, ...extra });
const plain = (): string => stripVTControlCharacters(status());

describe('quiet-mode log renderer', () => {
	it('counts every tool call exactly once and reports it in the status hint', () => {
		const captured: string[] = [];
		const original = stderr.write;
		stderr.write = ((text: string) => captured.push(text) > 0) as typeof stderr.write;
		try {
			expect(plain()).toBe('Press Ctrl+C to stop.');

			renderLog(line(30, 'tool call', { tool: 'read_measurement' }));
			expect(plain()).toBe('Tool calls: 1, successful: 1, failed: 0');

			renderLog(line(40, 'scpi exchange failed', { tool: 'read_measurement', err: { message: 'timeout' } }));
			renderLog(line(40, 'tool call failed', { tool: 'read_measurement', err: { message: 'timeout' } }));
			expect(plain()).toBe('Tool calls: 2, successful: 1, failed: 1');
			expect(captured.filter((text) => text.includes('timeout')).length).toBe(1);

			renderLog(line(30, 'tool call', { tool: 'identify' }));
			renderLog(line(30, 'tool call', { tool: 'identify' }));
			expect(plain()).toBe('Tool calls: 4, successful: 3, failed: 1');
			expect(captured.filter((text) => text.includes('identify')).length).toBe(0);

			renderLog(line(40, 'tool call failed', { tool: 'identify', err: { message: 'refused' } }));
			expect(plain()).toBe('Tool calls: 5, successful: 3, failed: 2');
			expect(captured.filter((text) => text.includes('refused')).length).toBe(1);
		} finally {
			stderr.write = original;
		}
	});
});
