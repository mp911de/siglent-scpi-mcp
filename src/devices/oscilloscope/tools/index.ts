import { acquisitionTools } from './acquisition.ts';
import { autosetTools } from './autoset.ts';
import { channelTools } from './channel.ts';
import { cursorTools } from './cursor.ts';
import { decodeTools } from './decode.ts';
import { digitalTools } from './digital.ts';
import { displayTools } from './display.ts';
import { fftTools } from './fft.ts';
import { historyTools } from './history.ts';
import { mathTools } from './math.ts';
import { measureTools } from './measure.ts';
import { obsoleteTools } from './obsolete.ts';
import { panelTools } from './panel.ts';
import { passFailTools } from './passfail.ts';
import { referenceTools } from './reference.ts';
import { serialTriggerTools } from './serial-trigger.ts';
import { systemTools } from './system.ts';
import { systemSettingsTools } from './system-settings.ts';
import { timebaseTools } from './timebase.ts';
import { triggerTools } from './trigger.ts';
import { waveformTools } from './waveform.ts';
import { wgenTools } from './wgen.ts';

export const tools = [
	...systemTools,
	...systemSettingsTools,
	...channelTools,
	...autosetTools,
	...acquisitionTools,
	...timebaseTools,
	...triggerTools,
	...serialTriggerTools,
	...cursorTools,
	...decodeTools,
	...digitalTools,
	...displayTools,
	...historyTools,
	...mathTools,
	...fftTools,
	...measureTools,
	...passFailTools,
	...panelTools,
	...referenceTools,
	...waveformTools,
	...wgenTools,
	...obsoleteTools,
];
