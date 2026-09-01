export interface Frame {
	payload: Buffer;
	end: number;
}

export type FrameReader = (buffer: Buffer) => Frame | undefined;

const LF = 0x0a;
const CR = 0x0d;
const HASH = 0x23;
const MAX_PREFIX = 64;

export const readText: FrameReader = (buffer) => {
	const start = skipLineBreaks(buffer);
	const lf = buffer.indexOf(LF, start);
	if (lf < 0) return undefined;
	const line = buffer.subarray(start, lf);
	return { payload: line.at(-1) === CR ? line.subarray(0, -1) : line, end: lf + 1 };
};

export const readAtLeast =
	(length: number): FrameReader =>
	(buffer) =>
		buffer.length < length ? undefined : { payload: buffer, end: buffer.length };

export const definiteLengthBlock = (payload: Buffer): Buffer =>
	Buffer.concat([Buffer.from(`#9${String(payload.length).padStart(9, '0')}`, 'ascii'), payload]);

export const readBinary: FrameReader = (buffer) => {
	const frame = announced(buffer);
	if (!frame) return undefined;
	const end = frame.start + frame.length;
	return buffer.length >= end ? { payload: buffer.subarray(frame.start, end), end } : undefined;
};

// How many payload bytes the answer says it is about to send, as soon as its header has arrived. A caller that has a
// smaller ceiling than the connection can refuse an answer here rather than after buffering all of it.
export const announcedLength = (buffer: Buffer): number | undefined => announced(buffer)?.length;

// A BMP counts its own header in the length it declares; an IEEE 488.2 block does not, so the payload starts after it.
function announced(buffer: Buffer): { start: number; length: number } | undefined {
	const start = skipLineBreaks(buffer);
	if (buffer.length >= start + 6 && buffer.toString('ascii', start, start + 2) === 'BM') {
		return { start, length: buffer.readUInt32LE(start + 2) };
	}
	const hash = buffer.indexOf(HASH, start);
	if (hash < 0 || hash - start > MAX_PREFIX || buffer.length < hash + 2) return undefined;
	const digits = buffer.readUInt8(hash + 1) - 0x30;
	const dataStart = hash + 2 + digits;
	if (digits < 1 || digits > 9 || buffer.length < dataStart) return undefined;
	const length = Number.parseInt(buffer.toString('ascii', hash + 2, dataStart), 10);
	return Number.isNaN(length) ? undefined : { start: dataStart, length };
}

function skipLineBreaks(buffer: Buffer): number {
	let index = 0;
	while (index < buffer.length && (buffer[index] === LF || buffer[index] === CR)) index++;
	return index;
}
