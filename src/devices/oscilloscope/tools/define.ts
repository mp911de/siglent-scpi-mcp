import type * as z from 'zod';
import type { ToolDefinition } from '../../../tools/define.ts';
import type { Scope } from '../scope.ts';

export { destructive, mutating, readOnly } from '../../../tools/define.ts';

export type ScopeTool = ToolDefinition<z.ZodObject, Scope>;

export const tool = <Input extends z.ZodObject>(definition: ToolDefinition<Input, Scope>): ScopeTool => definition;
