import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { elapsed, log, traced, withLogContext } from '../observability.ts';
import { ScpiError, withCancellation } from '../scpi/connection.ts';
import { type Instrument, UnsupportedError, withWarnings } from '../scpi/instrument.ts';

// The gate a high-impact tool sits behind. A tool without one is exposed unless a filter hides it.
export type Exposure = 'dangerous' | 'screenshots' | 'lock';

export interface ToolDefinition<Input extends z.ZodObject = z.ZodObject, I extends Instrument = Instrument> {
	name: string;
	description: string;
	input?: Input;
	annotations: ToolAnnotations;
	exposure?: Exposure;
	handler(args: z.output<Input>, instrument: I): Promise<Record<string, unknown>>;
}

export const readOnly: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
export const mutating: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
export const destructive: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};

export const tool = <Input extends z.ZodObject, I extends Instrument = Instrument>(
	definition: ToolDefinition<Input, I>,
): ToolDefinition<z.ZodObject, I> => definition;

export function registerTools<I extends Instrument>(
	server: McpServer,
	instrument: I,
	tools: readonly ToolDefinition<z.ZodObject, I>[],
): void {
	for (const definition of tools) {
		server.registerTool(
			definition.name,
			{
				description: definition.description,
				inputSchema: definition.input ?? z.object({}),
				annotations: definition.annotations,
			},
			(args, ctx) => invoke(definition, args, instrument, ctx),
		);
	}
}

// A handler returns JSON; the reserved `content` key carries MCP content blocks too large to belong in it.
type Attachments = Record<string, unknown> & { content?: CallToolResult['content'] };

export interface ToolError {
	error: string;
	kind: 'unsupported' | 'scpi' | 'error';
	model?: string;
	commands?: readonly string[];
	warnings?: readonly string[];
}

// `commands` means the same on a failure as on a success: the SCPI lines this call sent, which a request that
// fails part way still leaves on the instrument.
function describeError(error: unknown, instrument: Instrument, sent: string[], warnings: string[]): ToolError {
	const kind = error instanceof UnsupportedError ? 'unsupported' : error instanceof ScpiError ? 'scpi' : 'error';
	return {
		error: error instanceof Error ? error.message : String(error),
		kind,
		model: instrument.identity?.model,
		...(sent.length > 0 && { commands: sent }),
		...(warnings.length > 0 && { warnings }),
	};
}

function invoke<I extends Instrument>(
	definition: ToolDefinition<z.ZodObject, I>,
	args: z.output<z.ZodObject>,
	instrument: I,
	ctx: ServerContext,
): Promise<CallToolResult> {
	const warnings: string[] = [];
	const sent: string[] = [];
	return withLogContext({ tool: definition.name, request: ctx.mcpReq.id }, () =>
		withCancellation(
			ctx.mcpReq.signal,
			() =>
				traced(`tool ${definition.name}`, { 'mcp.tool.name': definition.name }, async () => {
					const started = performance.now();
					try {
						const { content = [], ...handled } = (await withWarnings(warnings, () =>
							definition.handler(args, instrument),
						)) as Attachments;
						const result = warnings.length > 0 ? { ...handled, warnings } : handled;
						log().info({ args, ms: elapsed(started) }, 'tool call');
						return {
							content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...content],
							structuredContent: result,
						};
					} catch (error) {
						log().warn({ err: error, args, ms: elapsed(started) }, 'tool call failed');
						const failure = describeError(error, instrument, sent, warnings);
						return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] };
					}
				}),
			sent,
		),
	);
}
