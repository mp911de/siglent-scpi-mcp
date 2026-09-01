import { acquisitionTools } from './acquisition.ts';
import { channelTools } from './channel.ts';
import { commonTools } from './common.ts';
import { counterTools } from './counter.ts';
import { cursorTools } from './cursor.ts';
import { decodeTools } from './decode.ts';
import { digitalTools } from './digital.ts';
import { displayTools } from './display.ts';
import { dvmTools } from './dvm.ts';
import { functionTools } from './function.ts';
import { historyTools } from './history.ts';
import { maskTools } from './mask.ts';
import { measureTools } from './measure.ts';
import { meterTools } from './meter.ts';
import { rootTools } from './root.ts';
import { searchTools } from './search.ts';
import { storageTools } from './storage.ts';
import { systemTools } from './system.ts';
import { timebaseTools } from './timebase.ts';
import { triggerTools } from './trigger.ts';
import { waveformTools } from './waveform.ts';
import { wgenTools } from './wgen.ts';

export const tools = [
	...commonTools,
	...rootTools,
	...acquisitionTools,
	...timebaseTools,
	...channelTools,
	...digitalTools,
	...triggerTools,
	...searchTools,
	...waveformTools,
	...functionTools,
	...measureTools,
	...cursorTools,
	...decodeTools,
	...displayTools,
	...historyTools,
	...counterTools,
	...maskTools,
	...dvmTools,
	...wgenTools,
	...meterTools,
	...storageTools,
	...systemTools,
];
