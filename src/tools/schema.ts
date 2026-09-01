import * as z from 'zod';

export const singleLine = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[^\r\n]+$/, 'Enter a single line without carriage returns or newlines');

// Letters, digits, underscore and hyphen only: a subset of legal DOS names that excludes every character with a
// meaning in the command grammar (comma, quote, semicolon, CR, LF, space) and every way to escape the directory.
export const pathSegment = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,8}$/, 'Use 1 to 8 letters, digits, underscores, or hyphens');

export const scpiValue = z
	.string()
	.regex(
		/^[-+]?\d+(\.\d+)?(E[-+]?\d+)?[A-Za-z]{0,3}$/i,
		'Enter a number with an optional unit, for example 500mV, 1.5V, or 10us',
	);

export const timeoutMs = z.number().int().min(100).max(120_000).optional().describe('Response timeout in milliseconds');

const unit = /^[-+]?\d+(\.\d+)?(E[-+]?\d+)?([A-Za-z]{1,3})$/i;

export const withUnit = (units: readonly string[], hint: string) =>
	scpiValue.refine((value) => units.includes((unit.exec(value)?.[3] ?? '').toUpperCase()), hint);

export const timeValue = withUnit(
	['S', 'MS', 'US', 'NS', 'PS'],
	'Enter a time with a unit, for example -3us or 1.5e-06s',
);
export const seconds = withUnit(
	['', 'S', 'MS', 'US', 'NS', 'PS'],
	'Enter a time, for example 5ns or 1.43us. Values without a unit are seconds',
);
export const voltageValue = withUnit(['V', 'MV', 'UV'], 'Enter a voltage with a unit, for example -500mV or 1V');
export const volts = withUnit(
	['', 'V', 'MV', 'UV'],
	'Enter a voltage in V, mV, or uV, for example 500mV or 2.5V. Values without a unit are volts',
);
export const hertz = withUnit(['HZ', 'KHZ', 'MHZ'], 'Enter a frequency with a unit, for example 1kHz or 58MHz');
export const thresholdVolts = withUnit(
	['', 'V', 'MV'],
	'Enter a voltage in V or mV, for example 3V or -500mV. Values without a unit are volts',
);
