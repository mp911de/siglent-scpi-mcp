import * as z from 'zod';
import { plan } from '../../../scpi/commands.ts';
import type { ScpiSession } from '../../../scpi/connection.ts';
import { asQuantity, parseQuantity, stripHeader } from '../../../scpi/values.ts';
import { applied, flag, inputs, param, readback, settings, type Values } from '../../../tools/params.ts';
import type { Channel, Scope } from '../scope.ts';
import { mutating, readOnly, tool } from './define.ts';
import { channel } from './schema.ts';

const operators: Record<string, string> = { add: '+', subtract: '-', multiply: '*', divide: '/' };
const transforms: Record<string, string> = { fft: 'FFT', integrate: 'INTG', differentiate: 'DIFF', sqrt: 'SQRT' };

const operation = z.enum(['add', 'subtract', 'multiply', 'divide', 'fft', 'integrate', 'differentiate', 'sqrt']);

export type MathOperation = z.infer<typeof operation>;

interface MathInput extends Values {
	operation?: MathOperation;
	sources?: Channel[];
}

const invert = (mnemonics: Record<string, string>) =>
	new Map(Object.entries(mnemonics).map(([name, symbol]) => [symbol, name as MathOperation]));

const byOperator = invert(operators);
const byTransform = invert(transforms);

const arity = (operation: MathOperation): number => (operation in operators ? 2 : 1);

const equationOf = (operation: MathOperation, [first, second]: readonly Channel[]): string =>
	operation in operators ? `${first}${operators[operation]}${second}` : `${transforms[operation]}${first}`;

const binary = /^(C[1-4])([-+*/])(C[1-4])$/;
const unary = /^(FFT|INTG|DIFF|SQRT)(C[1-4])$/;

function describeEquation(equation: string): { operation?: MathOperation; sources?: Channel[] } {
	const two = binary.exec(equation);
	if (two) return { operation: byOperator.get(two[2] ?? ''), sources: [two[1], two[3]] as Channel[] };
	const one = unary.exec(equation);
	if (one) return { operation: byTransform.get(one[1] ?? ''), sources: [one[2]] as Channel[] };
	return {};
}

export interface MathDefinition extends Values {
	operation?: MathOperation;
	sources?: Channel[];
	equation: string;
	equation_raw: string;
}

export async function readDefinition(session: ScpiSession): Promise<MathDefinition> {
	const raw = await session.query('DEF?');
	const equation = stripHeader(raw)
		.replace(/^EQN\s*,\s*/i, '')
		.replace(/['"\s]/g, '')
		.toUpperCase();
	return { ...describeEquation(equation), equation, equation_raw: raw };
}

// The guide lists this set for add, subtract, multiply and divide; other operations reject MTVD (p. 99).
const scales = [
	'500uV',
	'1mV',
	'2mV',
	'5mV',
	'10mV',
	'20mV',
	'50mV',
	'100mV',
	'200mV',
	'500mV',
	'1V',
	'2V',
	'5V',
	'10V',
	'20V',
	'50V',
	'100V',
] as const;

const isOn = (raw: string): boolean => stripHeader(raw).toUpperCase() === 'ON';
const pixels = (raw: string): unknown => parseQuantity(raw)?.value ?? raw;

const params = [
	flag(
		'inverted',
		'MATH:INVS',
		'Invert the math waveform. Available only for add, subtract, multiply, and divide.',
		isOn,
	),
	param(
		'vertical_scale',
		'MTVD',
		z.enum(scales),
		'Volts per division of the math waveform. Available only for add, subtract, multiply, and divide.',
		asQuantity,
	),
	param(
		'vertical_position',
		'MTVP',
		z.number().int().min(-255).max(255),
		'Vertical position from -255 to 255 screen pixels. One division is 50 pixels. Not available for FFT.',
		pixels,
	),
];

const arithmetic = new Set<MathOperation>(['add', 'subtract', 'multiply', 'divide']);

function requireOperation(operation: MathOperation, input: MathInput): void {
	const restricted = ['inverted', 'vertical_scale'].filter((name) => input[name] !== undefined);
	if (restricted.length > 0 && !arithmetic.has(operation)) {
		throw new Error(
			`${restricted.join(' and ')} apply only to Add, Subtract, Multiply, and Divide operations. Choose a compatible operation.`,
		);
	}
	if (input.vertical_position !== undefined && operation === 'fft') {
		throw new Error('vertical_position is not available for FFT. Use configure_fft to set the FFT vertical position.');
	}
}

async function guard(session: ScpiSession, scope: Scope, input: MathInput): Promise<void> {
	if (!params.some((p) => input[p.name] !== undefined)) return;
	const current = input.operation ?? (await readDefinition(session)).operation;
	if (current === undefined)
		scope.warn('The current math operation is unknown. The vertical settings were sent unchecked.');
	else requireOperation(current, input);
}

// `only` limits the read-back to what a request set; without it the whole math trace is read.
export async function readMath(session: ScpiSession, only?: Values): Promise<Values> {
	return {
		...(only && only.operation === undefined ? {} : await readDefinition(session)),
		...(await readback(session, only ? applied(params, only) : params)),
	};
}

export const mathTools = [
	tool({
		name: 'get_math',
		description:
			'Read the math operation, sources, inversion, vertical scale, and vertical position in pixels. An unrecognized equation is returned unparsed in equation_raw.',
		annotations: readOnly,
		handler: (_, scope) =>
			scope.execute((session) => {
				scope.requireLegacyDialect();
				return readMath(session);
			}),
	}),
	tool({
		name: 'configure_math',
		description:
			'Configure the math waveform. Add, Subtract, Multiply, and Divide take two channel sources. FFT, Integrate, Differentiate, and Square Root take one. Inversion and vertical scale are available only for arithmetic operations. Configure FFT vertical position with configure_fft.',
		input: z
			.object({
				operation: operation.optional().describe('Waveform math operation.'),
				sources: z
					.array(channel)
					.min(1)
					.max(2)
					.optional()
					.describe('Source channels. Arithmetic operations take two. Transform operations take one.'),
				...inputs(params),
			})
			.refine(
				({ operation, sources }) =>
					operation === undefined ? sources === undefined : sources?.length === arity(operation),
				'Provide operation and sources together. Add, Subtract, Multiply, and Divide require two sources. Transform operations require one.',
			),
		annotations: mutating,
		handler: (input: MathInput, scope) => {
			const commands = plan(
				input.operation && `DEF EQN,'${equationOf(input.operation, input.sources ?? [])}'`,
				...settings(params, input),
			);
			return scope.execute(async (session) => {
				scope.requireLegacyDialect();
				for (const source of input.sources ?? []) scope.requireChannel(source);
				await guard(session, scope, input);
				for (const command of commands) await session.command(command);
				return { commands, state: await readMath(session, input as Values) };
			});
		},
	}),
];
