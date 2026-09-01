export interface Setup {
	id: string;
	format: 'xml' | 'binary';
	bytes: number;
	sha256: string;
	captured_at: string;
	model?: string;
	firmware?: string;
}

// Ids are unguessable because every client of this endpoint shares the store; the payloads it holds are bounded and
// released when the scope connection closes.
export const setups = new Map<string, Setup & { payload: Buffer }>();

export const forgetPanelSetups = (): void => setups.clear();
