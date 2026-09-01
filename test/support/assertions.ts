import { expect } from '@assertive-ts/core';
import type { Client } from '@modelcontextprotocol/client';
import type { ToolError } from '../../src/tools/define.ts';
import type { FakeScope } from './fake-scope.ts';
import { type Harness, text } from './harness.ts';

type Result = Awaited<ReturnType<Client['callTool']>>;

export const payload = (result: Result): Record<string, unknown> => JSON.parse(text(result));

export function assertSent(fake: FakeScope, expected: string[]): void {
	expect(fake.sent()).toBeEqual(expected);
}

export async function assertInvalidSendsNothing(
	harness: Pick<Harness, 'fake' | 'client'>,
	name: string,
	args: Record<string, unknown>,
) {
	harness.fake.sent();
	const result = await harness.client.callTool({ name, arguments: args });
	expect(result.isError).toBe(true);
	assertSent(harness.fake, []);
	return result;
}

export async function assertReadOnly(client: Client, name: string): Promise<void> {
	const { tools } = await client.listTools();
	const annotations = tools.find((tool) => tool.name === name)?.annotations;
	expect(annotations).toBeTruthy();
	expect(annotations?.readOnlyHint).toBe(true);
	expect(annotations?.destructiveHint ?? false).toBe(false);
}

export function assertCapabilityError(result: Result, model: string | RegExp): ToolError {
	expect(result.isError).toBe(true);
	const error = JSON.parse(text(result)) as ToolError;
	expect(error.kind).toBe('unsupported');
	expect(error.model ?? '').toMatchRegex(typeof model === 'string' ? new RegExp(model) : model);
	return error;
}

export function assertUnknownWarning(result: Result, feature: string): void {
	expect(result.isError).not.toBe(true);
	const { warnings } = payload(result) as { warnings?: string[] };
	expect(warnings?.some((warning) => warning.includes(feature) && /unknown/i.test(warning))).toBeTruthy();
}
