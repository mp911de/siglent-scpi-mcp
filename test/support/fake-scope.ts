import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';

export type Reply = string | Buffer | ((socket: Socket) => void) | undefined;

export const identity = 'Siglent Technologies,SDS1104X-E,SDS1EBAC0L0098,7.6.1.20';

export class FakeScope {
	readonly received: string[] = [];
	accepted = 0;
	readonly replies = new Map<string, Reply>([['*IDN?', identity]]);
	fallback?: (line: string) => Reply;
	readonly #server: Server;
	readonly #sockets = new Set<Socket>();

	private constructor(server: Server) {
		this.#server = server;
	}

	static async start(replies: Record<string, Reply> = {}): Promise<FakeScope> {
		const server = createServer();
		const scope = new FakeScope(server);
		for (const [command, reply] of Object.entries(replies)) scope.replies.set(command, reply);
		server.on('connection', (socket) => scope.#accept(socket));
		await once(server.listen(0, '127.0.0.1'), 'listening');
		return scope;
	}

	get port(): number {
		const address = this.#server.address();
		return typeof address === 'object' && address ? address.port : 0;
	}

	get connections(): number {
		return this.#sockets.size;
	}

	sent(): string[] {
		return this.received.splice(0);
	}

	async until(match: string | ((wire: readonly string[]) => boolean)): Promise<void> {
		const reached = typeof match === 'string' ? (wire: readonly string[]) => wire.includes(match) : match;
		while (!reached(this.received)) await new Promise((resolve) => setImmediate(resolve));
	}

	dropConnections(): void {
		for (const socket of this.#sockets) socket.destroy();
	}

	async close(): Promise<void> {
		this.dropConnections();
		await new Promise((resolve) => this.#server.close(resolve));
	}

	#accept(socket: Socket): void {
		this.accepted += 1;
		this.#sockets.add(socket);
		socket.on('close', () => this.#sockets.delete(socket));
		socket.on('error', () => undefined);
		let buffered = '';
		socket.on('data', (chunk) => {
			buffered += chunk.toString('latin1');
			const lines = buffered.split('\n');
			buffered = lines.pop() ?? '';
			for (const line of lines) {
				this.received.push(line);
				const reply = this.replies.has(line) ? this.replies.get(line) : this.fallback?.(line);
				if (typeof reply === 'function') reply(socket);
				else if (reply !== undefined) socket.write(typeof reply === 'string' ? `${reply}\n` : reply);
			}
		});
	}
}
