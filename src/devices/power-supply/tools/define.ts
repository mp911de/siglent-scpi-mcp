import type * as z from 'zod';
import type { ToolDefinition } from '../../../tools/define.ts';
import type { PowerSupply } from '../supply.ts';

export { destructive, mutating, readOnly } from '../../../tools/define.ts';

export type SupplyTool = ToolDefinition<z.ZodObject, PowerSupply>;

export const tool = <Input extends z.ZodObject>(definition: ToolDefinition<Input, PowerSupply>): SupplyTool =>
	definition;
