import type * as z from 'zod';
import type { ToolDefinition } from '../../../tools/define.ts';
import type { ScpiScope } from '../scope.ts';

export { destructive, mutating, readOnly } from '../../../tools/define.ts';

export type ScpiScopeTool = ToolDefinition<z.ZodObject, ScpiScope>;

export const tool = <Input extends z.ZodObject>(definition: ToolDefinition<Input, ScpiScope>): ScpiScopeTool =>
	definition;
