export const onOff = (flag: boolean): string => (flag ? 'ON' : 'OFF');

type Part = string | false | undefined;

const present = (parts: Part[]): string[] => parts.filter((part): part is string => typeof part === 'string');

export function plan(...parts: Part[]): string[] {
	const commands = present(parts);
	if (commands.length === 0) throw new Error('Provide at least one setting to configure.');
	return commands;
}

// NR3 as the guide prints it: 1.00E-05, two exponent digits.
export function nr3(value: unknown): string {
	const [mantissa = '', exponent = ''] = Number(value).toExponential(2).split('e');
	return `${mantissa}E${exponent.startsWith('-') ? '-' : '+'}${exponent.replace(/^[-+]/, '').padStart(2, '0')}`;
}
