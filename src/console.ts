import { stderr, stdout } from 'node:process';
import { stripVTControlCharacters } from 'node:util';

const enabled = stdout.isTTY && stderr.isTTY && !process.env.NO_COLOR;
const code = (value: string): string => (enabled ? `\x1b[${value}m` : '');

export const ansi = {
	reset: code('0'),
	grey: code('2'),
	bold: code('1;37'),
	green: code('32'),
	red: code('31'),
	blue: code('94'),
	yellow: code('1;93'),
};

const width = (text: string): number => stripVTControlCharacters(text).length;

export function header(title: string, rows: Array<[string, string]>): void {
	const labels = Math.max(...rows.map(([label]) => label.length)) + 1;
	const lines = rows.map(([label, value]) => `${ansi.grey}${`${label}:`.padEnd(labels)}${ansi.reset}  ${value}`);
	const inner = Math.max(width(title), ...lines.map(width));
	const rule = '─'.repeat(inner + 2);
	const boxed = (content: string) =>
		`${ansi.grey}│${ansi.reset} ${content}${' '.repeat(inner - width(content))} ${ansi.grey}│${ansi.reset}`;
	const edge = (left: string, right: string) => `${ansi.grey}${left}${rule}${right}${ansi.reset}`;
	stdout.write(`\n${edge('╭', '╮')}\n${[title, '', ...lines].map(boxed).join('\n')}\n${edge('╰', '╯')}\n\n`);
}

export const ok = (message: string, details: string[] = []): void => step(stdout, message, `${ansi.green}✓`, details);
export const warn = (message: string): void => step(stdout, message, `${ansi.yellow}◆`);
export const fail = (message: string): void => step(stderr, message, `${ansi.red}✗`);
export const info = (message: string): void => void stdout.write(`  ${ansi.grey}·  ${message}${ansi.reset}\n`);
export const error = (message: string): void => void stderr.write(`${ansi.red}[ERROR]${ansi.reset} ${message}\n`);

const mark = 50;
const indent = ' '.repeat(8);
const bullet = (glyph: string, message: string) => `    ${ansi.blue}${glyph.padEnd(2)}${ansi.reset}  ${message}`;

function step(stream: NodeJS.WriteStream, message: string, icon: string, details: string[] = []): void {
	const line = bullet('▸▸', message);
	const detailed = details
		.map((detail) => `${indent}${ansi.grey}${stripVTControlCharacters(detail)}${ansi.reset}\n`)
		.join('');
	stream.write(`${line}${' '.repeat(Math.max(1, mark - 1 - width(line)))}${icon}${ansi.reset}\n${detailed}`);
}

const frames = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];

let live: ((text: string) => void) | undefined;

// Prints above the spinner block when one is animating, so a log line never tears the animation apart.
export function emit(text: string): void {
	if (live) live(text);
	else stderr.write(text);
}

const calls = { total: 0, failed: 0 };
let lastLogKey = '';

export const status = (): string =>
	calls.total === 0
		? 'Press Ctrl+C to stop.'
		: `Tool calls: ${calls.total}, successful: ${calls.total - calls.failed}, ${
				calls.failed ? `${ansi.reset}${ansi.red}failed: ${calls.failed}` : 'failed: 0'
			}`;

// The quiet-mode log sink: counts every tool call and renders warnings and errors as single lines.
export function renderLog(line: string): void {
	let entry: { level?: number; tool?: string; msg?: string; err?: { message?: string }; scpi?: { command?: string } };
	try {
		entry = JSON.parse(line);
	} catch {
		emit(line);
		return;
	}
	if (entry.msg === 'tool call' || entry.msg === 'tool call failed') {
		calls.total++;
		if (entry.msg === 'tool call failed') calls.failed++;
	}
	const level = entry.level ?? 0;
	if (level < 40) return;
	// A failed exchange logs twice, once from the interceptor and once from the tool wrapper. One line is enough.
	const key = `${entry.tool}|${entry.err?.message ?? entry.msg}`;
	if (key === lastLogKey) return;
	lastLogKey = key;
	const icon = level >= 50 ? `${ansi.red}✗` : `${ansi.yellow}◆`;
	const parts = [entry.tool, entry.scpi?.command, entry.err?.message ?? entry.msg].filter(Boolean);
	emit(`    ${icon}${ansi.reset}   ${parts.join(`${ansi.grey}  ·  ${ansi.reset}`)}\n`);
}

// Animates in place on a terminal; anywhere else (piped, redirected, NO_COLOR) it prints the same two lines once.
export function running(message: string, hint: () => string): () => void {
	const block = (glyph: string) => `${bullet(glyph, message)}\n${indent}${ansi.grey}${hint()}${ansi.reset}\n`;
	if (!enabled) {
		stdout.write(block('▸▸'));
		return () => {};
	}
	let frame = 0;
	const glyph = () => frames[frame % frames.length] ?? '';
	const over = (text: string) => stdout.write(`\x1b[2A\r\x1b[J${text}${block(glyph())}`);
	stdout.write(`\x1b[?25l${block(glyph())}`);
	const timer = setInterval(() => {
		frame++;
		over('');
	}, 80);
	timer.unref();
	live = over;
	return () => {
		clearInterval(timer);
		live = undefined;
		stdout.write(`\x1b[2A\r\x1b[J${block('▸▸')}\x1b[?25h`);
	};
}
