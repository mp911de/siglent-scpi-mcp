import { lanTools } from './lan.ts';
import { outputTools } from './output.ts';
import { protectionTools } from './protection.ts';
import { systemTools } from './system.ts';
import { timerTools } from './timer.ts';

export const tools = [...systemTools, ...outputTools, ...protectionTools, ...timerTools, ...lanTools];
