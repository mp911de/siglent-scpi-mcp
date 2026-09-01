import { readFileSync } from 'node:fs';
import { applyInventory } from './families.ts';

export const loadInventory = (file: string): string[] => applyInventory(JSON.parse(readFileSync(file, 'utf8')));
