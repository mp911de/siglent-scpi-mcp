import * as z from 'zod';
import { onOff, plan } from '../../../scpi/commands.ts';
import { ScpiError, type ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseFields, parseState } from '../../../scpi/values.ts';
import { applied, inputs, readback, settings, type Values } from '../../../tools/params.ts';
import { channels } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { main, reportDelay } from './timebase.ts';
import { sweep } from './trigger.ts';

const acquisitionStatuses = ['Stop', 'Ready', 'Armed', "Trig'd", 'Auto'] as const;
const switches = ['ON', 'OFF'] as const;
const acquisitionModes = ['SAMPLING', 'PEAK_DETECT', 'AVERAGE', 'HIGH_RES'] as const;
const averageCounts = [4, 16, 32, 64, 128, 256, 512, 1024] as const;
const memoryDepths = ['7K', '70K', '700K', '7M', '14K', '140K', '1.4M', '14M'] as const;

function parseAcquisitionMode(raw: string) {
	const [mode = '', count] = parseFields(raw);
	return { mode: parseState(mode, acquisitionModes), average_count: count ? Number(count) : undefined, raw };
}

const parseMemoryDepth = (raw: string) => ({ size: parseState(raw, memoryDepths), raw });
const parseStatus = (raw: string) => ({ state: parseState(raw, acquisitionStatuses), raw });

function parseSwitch(raw: string): boolean | undefined {
	const state = parseState(raw, switches);
	return state && state === 'ON';
}

const params = [...main, sweep];

// ACQW, AVGA and MSIZ are read as one group, because ACQW AVERAGE,16 carries the mode and the count together.
const readAcquired = async (session: ScpiSession) => ({
	acquisition_mode: parseAcquisitionMode(await session.query('ACQW?')),
	average_count: asQuantity(await session.query('AVGA?')),
	memory_depth: parseMemoryDepth(await session.query('MSIZ?')),
});

export async function readAcquisition(session: ScpiSession) {
	return {
		status: parseStatus(await session.query('SAST?')),
		sample_rate: asQuantity(await session.query('SARA?')),
		...(await readback(session, params)),
		...(await readAcquired(session)),
	};
}

// `only` limits the read-back to what a request set; without it both switches are read.
async function readDisplay(session: ScpiSession, only?: Values) {
	const sine = only && only.interpolation === undefined ? undefined : await session.query('SXSA?');
	const xy = only && only.xy_display === undefined ? undefined : await session.query('XYDS?');
	const on = sine === undefined ? undefined : parseSwitch(sine);
	return {
		...(sine === undefined
			? {}
			: { interpolation: { mode: on === undefined ? undefined : on ? 'sine' : 'linear', raw: sine } }),
		...(xy === undefined ? {} : { xy_display: { enabled: parseSwitch(xy), raw: xy } }),
	};
}

function verify(state: Awaited<ReturnType<typeof readAcquired>>, mode?: string, count?: number, depth?: string): void {
	const took = state.acquisition_mode;
	const mismatch =
		(mode && took.mode !== mode && `acquisition mode ${mode}`) ||
		(count && (state.average_count as { value?: number }).value !== count && `average count ${count}`) ||
		(depth && state.memory_depth.size !== depth && `memory depth ${depth}`);
	if (mismatch) {
		throw new ScpiError(
			`The scope did not apply ${mismatch}. It reported acquisition mode ${JSON.stringify(took.raw)}, average count ${JSON.stringify(state.average_count.raw)}, and memory depth ${JSON.stringify(state.memory_depth.raw)}. Choose values supported by the model and current interleave mode.`,
		);
	}
}

export const acquisitionTools = [
	tool({
		name: 'get_acquisition',
		description:
			'Read the acquisition state, including run status, sample rate, time per division, trigger delay, trigger mode, acquisition mode, average count, memory depth, interpolation, and XY display. With a source, also read the acquired point count of an analog channel or the digital sample rate. Digital acquisition requires an SDS1000X-E with the MSO option.',
		input: z.object({
			source: z
				.enum([...channels, 'digital'])
				.optional()
				.describe('Analog channel for its point count, or digital'),
		}),
		annotations: readOnly,
		handler: ({ source }, scope) =>
			scope.execute(async (session) => {
				scope.requireLegacyDialect();
				if (source && source !== 'digital') scope.requireChannel(source);
				if (source === 'digital') scope.requireSupport('mso_xe');
				const state = { ...(await readAcquisition(session)), ...(await readDisplay(session)) };
				if (source === 'digital') return { ...state, digital_sample_rate: asQuantity(await session.query('DI:SARA?')) };
				if (source) return { ...state, points: asQuantity(await session.query(`SANU? ${source}`)) };
				return state;
			}),
	}),
	tool({
		name: 'configure_acquisition',
		description:
			'Set the time per division, trigger delay, trigger mode, acquisition mode, average count, and memory depth. Optionally start or stop acquisition. Fails when the scope does not apply the requested acquisition mode, average count, or memory depth. Supported values vary by model and interleave mode.',
		input: z
			.object({
				...inputs(params),
				mode: z.enum(acquisitionModes).optional().describe('Acquisition mode. High Resolution requires an SPO model.'),
				average_count: z
					.literal(averageCounts)
					.optional()
					.describe('Number of samples to average. Set mode to Average when providing both values.'),
				memory_depth: z
					.enum(memoryDepths)
					.optional()
					.describe('Memory depth. Available depths depend on the active channels and interleave mode.'),
				action: z.enum(['run', 'stop']).optional().describe('Start or stop acquisition.'),
			})
			.refine(({ mode, average_count }) => !average_count || !mode || mode === 'AVERAGE', {
				message: 'average_count requires mode AVERAGE',
				path: ['average_count'],
			}),
		annotations: mutating,
		handler: (input, scope) => {
			const { mode, average_count, memory_depth, action } = input;
			const commands = plan(
				...settings(params, input),
				mode && (average_count ? `ACQW ${mode},${average_count}` : `ACQW ${mode}`),
				!mode && average_count && `AVGA ${average_count}`,
				memory_depth && `MSIZ ${memory_depth}`,
				action && (action === 'run' ? 'ARM' : 'STOP'),
			);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				reportDelay(scope, input);
				if (mode === 'HIGH_RES') scope.requireSupport('spo');
				for (const command of commands) await session.command(command);
				const status = action === undefined ? undefined : parseStatus(await session.query('SAST?'));
				const echoed = await readback(session, applied(params, input as Values));
				const grouped = mode !== undefined || average_count !== undefined || memory_depth !== undefined;
				const group = grouped ? await readAcquired(session) : undefined;
				if (group) verify(group, mode, average_count, memory_depth);
				return { commands, state: { ...(status && { status }), ...echoed, ...group } };
			});
		},
	}),
	tool({
		name: 'configure_acquisition_display',
		description: 'Set waveform interpolation and XY display mode.',
		input: z.object({
			interpolation: z.enum(['sine', 'linear']).optional(),
			xy_display: z.boolean().optional().describe('Plot channels against each other instead of time'),
		}),
		annotations: mutating,
		handler: ({ interpolation, xy_display }, scope) => {
			const commands = plan(
				interpolation && `SXSA ${onOff(interpolation === 'sine')}`,
				xy_display !== undefined && `XYDS ${onOff(xy_display)}`,
			);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				for (const command of commands) await session.command(command);
				return { commands, state: await readDisplay(session, { interpolation, xy_display }) };
			});
		},
	}),
];
