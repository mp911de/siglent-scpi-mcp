import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { expect } from '@assertive-ts/core';
import { type CommandEntry, manifest } from '../../../src/devices/oscilloscope-scpi/manifest.ts';
import { tools } from '../../../src/devices/oscilloscope-scpi/tools/index.ts';
import type { Exchange, ExchangeInterceptor } from '../../../src/scpi/connection.ts';
import type { ToolError } from '../../../src/tools/define.ts';
import { payload } from '../../support/assertions.ts';
import { startScpiHarness } from '../../support/harness.ts';
import { block, codes, wavedesc } from '../../support/wavedesc.ts';
import { serialTriggers } from './serial-triggers.ts';

const expected: Record<string, number> = {
	common: 3,
	root: 3,
	acquire: 13,
	channel: 14,
	counter: 12,
	cursor: 15,
	decode: 90,
	digital: 14,
	display: 13,
	dvm: 7,
	function: 38,
	history: 6,
	measure: 30,
	memory: 9,
	mtest: 13,
	recall: 4,
	ref: 6,
	save: 7,
	search: 34,
	system: 24,
	timebase: 7,
	trigger: 246,
	waveform: 9,
	wgen: 6,
	meter: 29,
};

describe('EN11F coverage manifest', () => {
	it('lists 652 unique identifiers', () => {
		expect(manifest.length).toBe(652);
		expect(new Set(manifest.map(({ id }) => id)).size).toBe(652);
	});

	it('matches the guide coverage map per subsystem', () => {
		const counts: Record<string, number> = {};
		for (const { subsystem } of manifest) counts[subsystem] = (counts[subsystem] ?? 0) + 1;
		expect(counts).toBeEqual(expected);
	});

	it('has a consistent response kind, an owner and a tool on every row', () => {
		for (const entry of manifest) {
			if (entry.forms === 'command') expect(entry.response).toBe('none');
			expect(entry.tools.length > 0).toBeTruthy();
			expect(entry.owner.startsWith('devices/oscilloscope-scpi/')).toBeTruthy();
		}
	});

	// A note marks a row whose coverage is less than whole. The reason belongs where a reader finds it, which is the
	// row itself and the coverage matrix it renders into, not an agent report.
	it('states a reason on every row that carries a limitation', () => {
		const unexplained = manifest.filter(({ note }) => note !== undefined && !note.trim());
		const explained: typeof unexplained = [];
		expect(unexplained.map(({ id }) => id)).toBeEqual([]);
		expect(explained.map(({ id }) => id)).toBeEqual([]);
	});

	it('marks a row destructive for every tool that demands a confirmation', () => {
		const unconfirmed: string[] = [];
		for (const { name, input } of tools) {
			const confirms = Object.keys(input?.shape ?? {}).some((key) => key.startsWith('confirm_'));
			const owned = manifest.filter(({ tools: named }) => named.includes(name));
			if (confirms && !owned.some(({ mutability }) => mutability === 'destructive')) unconfirmed.push(name);
		}
		expect(unconfirmed).toBeEqual([]);
	});

	it('never leaves a row that writes to read-only tools alone', () => {
		const annotations = new Map(tools.map(({ name, annotations: hints }) => [name, hints]));
		const writes = manifest.filter(({ mutability, tools: named }) => mutability !== 'read' && named.length > 0);
		const readOnly = writes.filter(({ tools: named }) => named.every((name) => annotations.get(name)?.readOnlyHint));
		const undeclared = writes
			.filter(({ mutability }) => mutability === 'destructive')
			.filter(({ tools: named }) => !named.some((name) => annotations.get(name)?.destructiveHint));
		expect(readOnly.map(({ id }) => id)).toBeEqual([]);
		expect(undeclared.map(({ id }) => id)).toBeEqual([]);
	});

	it('implements every row somewhere in the module that owns it', () => {
		const read = (path: string) => readFileSync(new URL(`../../../src/${path}.ts`, import.meta.url), 'utf8');
		const missing = manifest
			.filter(({ id, owner }) => {
				const marker = id === '*IDN' ? 'scope.identify' : id;
				return !read(owner).includes(marker);
			})
			.map(({ id, owner }) => `${id} (${owner})`);
		expect(missing).toBeEqual([]);
	});

	it('names only registered tools', () => {
		const registered = new Set(tools.map(({ name }) => name));
		for (const { tools: named } of manifest) {
			for (const name of named) expect(registered.has(name)).toBeTruthy();
		}
	});
});

// The manifest transcribes the guide independently of the tools. Driving every tool against a fake scope and matching
// the lines it sends against that transcription turns "the guide has a query for this" into a checked fact: an
// undocumented query blocks for the whole timeout and tears the connection down.
// The trigger fixtures below write one type at a time; these are the answers the fake gives back for them.
const answers = (prefix: string, leaves: Record<string, string>): Record<string, string> =>
	Object.fromEntries(Object.entries(leaves).map(([leaf, value]) => [`${prefix}${leaf}?`, value]));

const heldOff = { HLDEVent: '3', HLDTime: '1.50E-08', HOLDoff: 'EVENts', HSTart: 'ACQ_START' };
const shared = { ...heldOff, COUPling: 'HFREJect', NREJect: 'OFF', SOURce: 'C2' };
const bounded = { LIMit: 'INNer', TLOWer: '1.00E-08', TUPPer: '3.00E-08' };
const windowed = { HLEVel: '5.00E-01', LLEVel: '-5.00E-01' };

const triggerReplies: Record<string, string> = {
	':TRIGger:MODE?': 'SINGle',
	':TRIGger:STATus?': 'Stop',
	':TRIGger:TYPE?': 'EDGE',
	':TRIGger:FREQuency?': '1.234561E+04',
	...answers(':TRIGger:EDGE:', {
		...heldOff,
		HOLDoff: 'TIME',
		HSTart: 'LAST_TRIG',
		COUPling: 'DC',
		NREJect: 'ON',
		SOURce: 'EX',
		IMPedance: 'FIFTy',
		SLOPe: 'ALTernate',
		LEVel: '5.00E-01',
	}),
	...answers(':TRIGger:SLOPe:', { ...shared, ...bounded, ...windowed, SLOPe: 'RISing' }),
	...answers(':TRIGger:PULSe:', { ...shared, ...bounded, SOURce: 'D3', POLarity: 'POSitive', LEVel: '5.00E-01' }),
	...answers(':TRIGger:INTerval:', { ...shared, ...bounded, SLOPe: 'RISing', LEVel: '5.00E-01' }),
	...answers(':TRIGger:WINDow:', { ...shared, ...windowed, TYPE: 'RELative', CLEVel: '0.00E+00', DLEVel: '5.00E-01' }),
	...answers(':TRIGger:DROPout:', { ...shared, TYPE: 'EDGE', SLOPe: 'FALLing', LEVel: '5.00E-01', TIME: '1.00E-08' }),
	...answers(':TRIGger:RUNT:', { ...shared, ...bounded, ...windowed, POLarity: 'NEGative' }),
	...answers(':TRIGger:VIDeo:', {
		SOURce: 'C2',
		STANdard: 'CUSTom',
		FRATe: '50Hz',
		LCNT: '800',
		FCNT: '8',
		INTerlace: '8',
		LEVel: '5.00E-01',
		SYNC: 'SELect',
		FIELd: '2',
		LINE: '100',
	}),
	...answers(':TRIGger:PATTern:', { ...heldOff, ...bounded, INPut: 'H,L,X,X', LOGic: 'AND' }),
	...answers(':TRIGger:QUALified:', {
		...bounded,
		ESource: 'C1',
		ELEVel: '5.00E-01',
		ESLope: 'RISing',
		QSource: 'C2',
		QLEVel: '-5.00E-01',
		TYPE: 'EDGE,RISing',
	}),
	...answers(':TRIGger:DELay:', {
		...bounded,
		SOURce: 'H,L,X,X',
		SLOPe: 'RISing',
		SOURce2: 'C3',
		LEVel2: '5.00E-01',
		SLOPe2: 'FALLing',
		COUPling: 'DC',
	}),
	...answers(':TRIGger:NEDGe:', {
		...heldOff,
		SOURce: 'C1',
		SLOPe: 'FALLing',
		LEVel: '5.00E-01',
		IDLE: '1.50E-08',
		EDGE: '3',
		NREJect: 'ON',
	}),
	...answers(':TRIGger:SHOLd:', {
		...bounded,
		TYPE: 'SETup',
		CSource: 'C1',
		CTHReshold: '1.50E+00',
		SLOPe: 'RISing',
		DSource: 'C2',
		DTHReshold: '1.50E+00',
		LEVel: 'HIGH',
	}),
	...answers(':TRIGger:IIC:', {
		SCLSource: 'C1',
		SCLThreshold: '1.50E+00',
		SDASource: 'C2',
		SDAThreshold: '1.50E+00',
		ALENgth: '7BIT',
		DLENgth: '12',
		CONDition: 'EEPRom',
		ADDRess: '80',
		RWBit: 'READ',
		LIMit: 'EQUal',
		DATA: '255',
		DAT2: '256',
	}),
	...answers(':TRIGger:SPI:', {
		CLKSource: 'C1',
		CLKThreshold: '1.50E+00',
		MOSISource: 'C2',
		MOSIThreshold: '1.50E+00',
		MISOSource: 'C3',
		MISOThreshold: '1.50E+00',
		CSSource: 'C4',
		CSThreshold: '1.50E+00',
		NCSSource: 'D0',
		NCSThreshold: '1.50E+00',
		CSTYpe: 'TIMeout,1.00E-06',
		LATChedge: 'RISing',
		BITorder: 'MSB',
		TTYPe: 'MOSI',
		DLENgth: '8',
	}),
	...answers(':TRIGger:UART:', {
		RXSource: 'C1',
		RXThreshold: '1.50E+00',
		TXSource: 'C2',
		TXThreshold: '1.50E+00',
		BAUD: '9600bps',
		BITorder: 'LSM',
		PARity: 'EVEN',
		STOP: '1.5',
		IDLE: 'HIGH',
		DLENgth: '8',
		TTYPe: 'RX',
		CONDition: 'DATA',
		LIMit: 'EQUal',
		DATA: '255',
	}),
	...answers(':TRIGger:CAN:', {
		SOURce: 'C1',
		THReshold: '1.50E+00',
		BAUD: 'CUSTom,500000',
		IDLength: '29BITS',
		CONDition: 'ID_AND_DATA',
		ID: '1234',
		DATA: '255',
		DAT2: '256',
	}),
	...answers(':TRIGger:CANFd:', {
		SOURce: 'C1',
		THReshold: '1.50E+00',
		BAUDNominal: '1Mbps',
		BAUDData: '5Mbps',
		FTYPe: 'CANFd',
		IDLength: '11BITS',
		CONDition: 'ID',
		ID: '1024',
		DATA: '255',
		DAT2: '256',
	}),
	...answers(':TRIGger:LIN:', {
		SOURce: 'C1',
		THReshold: '1.50E+00',
		BAUD: '19200bps',
		CONDition: 'DATA_ERROR',
		ID: '64',
		DATA: '255',
		DAT2: '256',
		'ERRor:CHECksum': '1',
		'ERRor:PARity': '0',
		'ERRor:SYNC': '1',
		STANdard: '1',
		'ERRor:ID': '63',
		'ERRor:DLENgth': '8',
	}),
	...answers(':TRIGger:FLEXray:', {
		SOURce: 'C1',
		THReshold: '1.50E+00',
		BAUD: '10Mbps',
		CONDition: 'FRAMe',
		'FRAMe:ID': '2048',
		'FRAMe:COMPare': 'EQUal',
		'FRAMe:CYCLe': '63',
		'FRAMe:REPetition': '64',
	}),
	...answers(':TRIGger:IIS:', {
		BCLKSource: 'C1',
		BCLKThreshold: '1.50E+00',
		WSSource: 'C2',
		WSTHreshold: '1.50E+00',
		DSource: 'C3',
		DTHReshold: '1.50E+00',
		AVARiant: 'LJ',
		'BCLK:EDGE': 'FALLing',
		BITorder: 'MSB',
		LCH: 'LOW',
		CHANnel: 'RIGHT',
		DLENgth: '32',
		CONDition: 'DATA',
		COMPare: 'GREaterthan',
		VALue: '65535',
	}),
	...answers(':TRIGger:SENT:', { SOURce: 'C1', THReshold: '1.50E+00' }),
};

const searchReplies: Record<string, string> = {
	':SEARch?': 'ON',
	':SEARch:MODE?': 'EDGE',
	':SEARch:COUNt?': '10',
	':SEARch:EVENt?': '5',
	...answers(':SEARch:EDGE:', { SOURce: 'C2', SLOPe: 'ALTernate', LEVel: '5.00E-01' }),
	...answers(':SEARch:SLOPe:', { ...bounded, ...windowed, SOURce: 'C2', SLOPe: 'RISing' }),
	...answers(':SEARch:PULSe:', { ...bounded, SOURce: 'D3', POLarity: 'POSitive', LEVel: '5.00E-01' }),
	...answers(':SEARch:INTerval:', { ...bounded, SOURce: 'C2', SLOPe: 'RISing', LEVel: '5.00E-01' }),
	...answers(':SEARch:RUNT:', { ...bounded, ...windowed, SOURce: 'C2', POLarity: 'NEGative' }),
};

const maskReplies: Record<string, string> = {
	':MTESt?': 'ON',
	':MTESt:COUNt?': 'FAIL,38176,PASS,5617,TOTAL,43793',
	':MTESt:FUNCtion:BUZZer?': 'ON',
	':MTESt:FUNCtion:COF?': 'OFF',
	':MTESt:FUNCtion:FTH?': 'ON',
	':MTESt:FUNCtion:SOF?': 'OFF',
	':MTESt:IDISplay?': 'ON',
	':MTESt:OPERate?': 'ON',
	':MTESt:SOURce?': 'C1',
	':MTESt:TYPE?': 'ALL_IN',
};

const measureReplies: Record<string, string> = {
	':MEASure?': 'ON',
	':MEASure:MODE?': 'ADVanced',
	':MEASure:SIMPle:SOURce?': 'C1',
	':MEASure:SIMPle:VALue? ALL': '2.000E+00,1.000E+00',
	':MEASure:SIMPle:VALue? MAX': '2.000E+00',
	':MEASure:SIMPle:VALue? PKPK': '1.000E+00',
	':MEASure:ADVanced:LINenumber?': '2',
	':MEASure:ADVanced:STYLe?': 'M1',
	':MEASure:ADVanced:P1?': 'ON',
	':MEASure:ADVanced:P1:TYPE?': 'SKEW',
	':MEASure:ADVanced:P1:SOURce1?': 'C1',
	':MEASure:ADVanced:P1:SOURce2?': 'C2',
	':MEASure:ADVanced:P1:VALue?': '4.033E+00',
	':MEASure:ADVanced:P1:STATistics? ALL': '6.7E-02,6.8E-02,7.0E-02,6.5E-02,1.0E-03,128',
	':MEASure:ADVanced:P1:STATistics? CURRent': '6.7E-02',
	':MEASure:ADVanced:P2?': 'OFF',
	':MEASure:ADVanced:STATistics?': 'ON',
	':MEASure:ADVanced:STATistics:HISTOGram?': 'ON',
	':MEASure:ADVanced:STATistics:MAXCount?': '1024',
	':MEASure:ADVanced:STATistics:AIMLimit?': '500',
	':MEASure:ASTRategy?': 'AUTO',
	':MEASure:ASTRategy:TOP?': 'HISTogram',
	':MEASure:ASTRategy:BASE?': 'HISTogram',
	':MEASure:GATE?': 'ON',
	':MEASure:GATE:GA?': '-1.00E-07',
	':MEASure:GATE:GB?': '1.00E-07',
	':MEASure:THReshold:SOURce?': 'C1',
	':MEASure:THReshold:TYPE?': 'PERCent',
	':MEASure:THReshold:ABSolute?': '3.00E+00,1.00E+00,-1.50E+00',
	':MEASure:THReshold:PERCent?': '80,45,10',
};

const cursorReplies: Record<string, string> = {
	':CURSor?': 'ON',
	':CURSor:MODE?': 'MEASure',
	':CURSor:MITem?': 'PKPK,C2',
	':CURSor:TAGStyle?': 'FIXed',
	':CURSor:SOURce1?': 'C1',
	':CURSor:SOURce2?': 'C2',
	':CURSor:XREFerence?': 'DELay',
	':CURSor:YREFerence?': 'OFFSet',
	':CURSor:X1?': '-1.00E-06',
	':CURSor:X2?': '1.00E-06',
	':CURSor:Y1?': '1.20E+01',
	':CURSor:Y2?': '1.00E+01',
	':CURSor:XDELta?': '2.00E-06',
	':CURSor:IXDelta?': '5.00E+05',
	':CURSor:YDELta?': '2.00E+00',
};

const counterReplies: Record<string, string> = {
	':COUNter?': 'ON',
	':COUNter:MODE?': 'TOTalizer',
	':COUNter:SOURce?': 'C1',
	':COUNter:LEVel?': '5.00E-01',
	':COUNter:STATistics?': 'ON',
	':COUNter:TOTalizer:GATE?': 'ON',
	':COUNter:TOTalizer:GATE:LEVel?': '5.00E-01',
	':COUNter:TOTalizer:GATE:SLOPe?': 'RISing',
	':COUNter:TOTalizer:GATE:TYPE?': 'LEVel',
	':COUNter:TOTalizer:SLOPe?': 'RISing',
};

const displayReplies: Record<string, string> = {
	':DISPlay:AXIS?': 'ON',
	':DISPlay:AXIS:MODE?': 'FIXed',
	':DISPlay:BACKlight?': '100',
	':DISPlay:COLor?': 'ON',
	':DISPlay:GRATicule?': '50',
	':DISPlay:GRIDstyle?': 'LIGHt',
	':DISPlay:INTensity?': '75',
	':DISPlay:MENU?': 'FLOating',
	':DISPlay:MENU:HIDE?': '10S',
	':DISPlay:PERSistence?': '5S',
	':DISPlay:TRANsparence?': '50',
	':DISPlay:TYPE?': 'VECTor',
};

const historyReplies: Record<string, string> = {
	':HISTORy?': 'ON',
	':HISTORy:FRAMe?': '4',
	':HISTORy:INTERval?': '1.00E-03',
	':HISTORy:LIST?': 'ON,TIME',
	':HISTORy:PLAY?': 'PAUSe',
	':HISTORy:TIME?': '07:48:09.253827',
};

const digitalReplies: Record<string, string> = {
	':DIGital?': 'ON',
	':DIGital:ACTive?': 'D5',
	':DIGital:HEIGht?': '6.00E+00',
	':DIGital:POSition?': '4.00E+00',
	':DIGital:SKEW?': '1.00E-07',
	':DIGital:SRATe?': '1.25E+09',
	':DIGital:POINts?': '6.25E+02',
	':DIGital:D5?': 'ON',
	':DIGital:LABel5?': '"IIC_DATA"',
	':DIGital:THReshold1?': 'CMOS',
	':DIGital:THReshold2?': 'CUSTom,1.50E+00',
	':DIGital:BUS1:DISPlay?': 'ON',
	':DIGital:BUS1:FORMat?': 'HEX',
	':DIGital:BUS1:MAP?': 'D0,D3,D7,D15',
	':DIGital:BUS2:DISPlay?': 'OFF',
	':DIGital:BUS2:FORMat?': 'BINary',
	':DIGital:BUS2:MAP?': 'D0,D1,D2,D3',
};

// Bus 1 decodes IIC, bus 2 USB20, one of the two protocols the guide documents no parameter command for, which is
// what makes get_decode take the branch that reads the bus state alone.
const decodeReplies: Record<string, string> = {
	':DECode?': 'ON',
	':DECode:LIST?': 'D1',
	':DECode:LIST:LINE?': '6',
	':DECode:LIST:SCRoll?': '3',
	':DECode:BUS1?': 'ON',
	':DECode:BUS1:FORMat?': 'HEX',
	':DECode:BUS1:PROTocol?': 'IIC',
	':DECode:BUS1:RESult?': 'iic,address,rw,data;0x50,W,1,0x12\\s0x34;0x50,R,0,0x56;',
	':DECode:BUS1:IIC:SCLSource?': 'C1',
	':DECode:BUS1:IIC:SCLThreshold?': '1.50E+00',
	':DECode:BUS1:IIC:SDASource?': 'C2',
	':DECode:BUS1:IIC:SDAThreshold?': '1.50E+00',
	':DECode:BUS1:IIC:RWBit?': 'ON',
	':DECode:BUS1:SPI:CLKSource?': 'C1',
	':DECode:BUS1:SPI:CLKThreshold?': '1.50E+00',
	':DECode:BUS1:SPI:MOSISource?': 'C2',
	':DECode:BUS1:SPI:MOSIThreshold?': '1.50E+00',
	':DECode:BUS1:SPI:MISOSource?': 'DIS',
	':DECode:BUS1:SPI:MISOThreshold?': '1.50E+00',
	':DECode:BUS1:SPI:CSSource?': 'C3',
	':DECode:BUS1:SPI:CSThreshold?': '1.50E+00',
	':DECode:BUS1:SPI:NCSSource?': 'D0',
	':DECode:BUS1:SPI:NCSThreshold?': '1.50E+00',
	':DECode:BUS1:SPI:CSTYpe?': 'TIMeout,1.00E-06',
	':DECode:BUS1:SPI:LATChedge?': 'RISing',
	':DECode:BUS1:SPI:BITorder?': 'MSB',
	':DECode:BUS1:SPI:DLENgth?': '8',
	':DECode:BUS1:UART:RXSource?': 'C1',
	':DECode:BUS1:UART:RXThreshold?': '1.50E+00',
	':DECode:BUS1:UART:TXSource?': 'DIS',
	':DECode:BUS1:UART:TXThreshold?': '1.50E+00',
	':DECode:BUS1:UART:BAUD?': '9600bps',
	':DECode:BUS1:UART:BITorder?': 'LSB',
	':DECode:BUS1:UART:PARity?': 'EVEN',
	':DECode:BUS1:UART:STOP?': '1.5',
	':DECode:BUS1:UART:IDLE?': 'HIGH',
	':DECode:BUS1:UART:DLENgth?': '8',
	':DECode:BUS1:CAN:SOURce?': 'C1',
	':DECode:BUS1:CAN:THReshold?': '1.50E+00',
	':DECode:BUS1:CAN:BAUD?': '500kbps',
	':DECode:BUS1:LIN:SOURce?': 'C1',
	':DECode:BUS1:LIN:THReshold?': '1.50E+00',
	':DECode:BUS1:LIN:BAUD?': '9600bps',
	':DECode:BUS1:FLEXray:SOURce?': 'C1',
	':DECode:BUS1:FLEXray:THReshold?': '1.50E+00',
	':DECode:BUS1:FLEXray:BAUD?': '5Mbps',
	':DECode:BUS1:CANFd:SOURce?': 'C1',
	':DECode:BUS1:CANFd:THReshold?': '1.50E+00',
	':DECode:BUS1:CANFd:BAUDNominal?': '250kbps',
	':DECode:BUS1:CANFd:BAUDData?': '2Mbps',
	':DECode:BUS1:IIS:BCLKSource?': 'C1',
	':DECode:BUS1:IIS:BCLKThreshold?': '1.50E+00',
	':DECode:BUS1:IIS:WSSource?': 'C2',
	':DECode:BUS1:IIS:WSTHreshold?': '1.50E+00',
	':DECode:BUS1:IIS:DSource?': 'C3',
	':DECode:BUS1:IIS:DTHReshold?': '1.50E+00',
	':DECode:BUS1:IIS:AVARiant?': 'I2S',
	':DECode:BUS1:IIS:LATChedge?': 'RISing',
	':DECode:BUS1:IIS:BITorder?': 'MSB',
	':DECode:BUS1:IIS:LCH?': 'LOW',
	':DECode:BUS1:IIS:ANNotate?': 'ALL',
	':DECode:BUS1:IIS:SBIT?': '0',
	':DECode:BUS1:IIS:DLENgth?': '16',
	':DECode:BUS1:M1553:SOURce?': 'C1',
	':DECode:BUS1:M1553:UTHReshold?': '2.00E+00',
	':DECode:BUS1:M1553:LTHReshold?': '1.00E+00',
	':DECode:BUS1:SENT:SOURce?': 'C1',
	':DECode:BUS1:SENT:THReshold?': '1.50E+00',
	':DECode:BUS1:SENT:FORMat?': 'NIBBles',
	':DECode:BUS1:SENT:IDLE?': 'HIGH',
	':DECode:BUS1:SENT:CRC?': 'ON',
	':DECode:BUS1:SENT:PPULse?': 'OFF',
	':DECode:BUS1:SENT:CLOCk?': '1.00E-06',
	':DECode:BUS1:SENT:TOLerance?': '5',
	':DECode:BUS1:SENT:LENGth?': '6',
	':DECode:BUS1:MANChester:SOURce?': 'C1',
	':DECode:BUS1:MANChester:THReshold?': '1.50E+00',
	':DECode:BUS1:MANChester:BAUD?': '9600',
	':DECode:BUS1:MANChester:POLarity?': 'RISing',
	':DECode:BUS1:MANChester:IDLE?': 'LOW',
	':DECode:BUS1:MANChester:BITorder?': 'MSB',
	':DECode:BUS1:MANChester:DISPlay?': 'WORD',
	':DECode:BUS1:MANChester:IBITs?': '4',
	':DECode:BUS1:MANChester:STARt?': '1',
	':DECode:BUS1:MANChester:SSIZe?': '8',
	':DECode:BUS1:MANChester:HSIZe?': '8',
	':DECode:BUS1:MANChester:TSIZe?': '8',
	':DECode:BUS1:MANChester:WSIZe?': '8',
	':DECode:BUS1:MANChester:DSIZe?': '32',
	':DECode:BUS2?': 'OFF',
	':DECode:BUS2:FORMat?': 'BINary',
	':DECode:BUS2:PROTocol?': 'USB20',
};

// The generator answers one line per section, the way the SDG-style WGEN sections print them (pp. 701-709).
const wgenReplies: Record<string, string> = {
	'C1:ARbWaVe?': 'C1:ARWV INDEX,2,NAME,StairUp',
	'C1:BaSic_WaVe?': 'C1:BSWV WVTP,SINE,FRQ,1000HZ,PERI,0.001S,AMP,2V,OFST,0V,HLEV,1V,LLEV,-1V,PHSE,0',
	'C1:OUTPut?': 'C1:OUTP OFF,LOAD,50,PLRT,NOR',
	'C1:SYNC?': 'C1:SYNC ON,TYPE,CH1',
	'VOLTPRT?': 'VOLTPRT ON',
	'SToreList?': 'STL M10, ExpFal, M2, StairUp',
	'SToreList? USER': 'STL M50, wave_1',
};

// The meter answers only on the handheld family, which is why the third driven model is one.
const meterReplies: Record<string, string> = {
	'CONFigure?': 'DCV -0.04mV',
	'READ?': 'MM_VALUE 0.00V',
	'MEASure:CONTinuity?': '+9.84739065E+02',
	'MEASure:CURRent:AC? 6A': '+4.32133675E-04',
	'MEASure:CURRent:DC? 6A': '+4.32133675E-04',
	'MEASure:DIODe?': '+9.84733701E-01',
	'MEASure:RESistance? 600': '+6.71881065E+01',
	'MEASure:VOLTage:AC? 60V': '+2.43186951E-02',
	'MEASure:VOLTage:DC? 60V': 'Overload',
	'MEASure:CAPacitance?': '+7.26141264E-10',
};

const dvmReplies: Record<string, string> = {
	':DVM?': 'ON',
	':DVM:SOURce?': 'C2',
	':DVM:MODE?': 'AMPLitude',
	':DVM:ARANge?': 'ON',
	':DVM:ALARm?': 'ON',
	':DVM:HOLD?': 'OFF',
	':DVM:CURRent?': '0.98E+00',
};

// The INTegrate operation makes get_math read the gate branch, and get_fft warn that F1 runs no FFT.
const functionReplies: Record<string, string> = {
	':FUNCtion1?': 'ON',
	':FUNCtion1:OPERation?': 'INTegrate',
	':FUNCtion1:SOURce1?': 'C1',
	':FUNCtion1:SOURce2?': 'C2',
	':FUNCtion1:INVert?': 'OFF',
	':FUNCtion1:SCALe?': '1.00E+00',
	':FUNCtion1:POSition?': '5.00E-01',
	':FUNCtion1:LABel?': 'ON',
	':FUNCtion1:LABel:TEXT?': '"MATH"',
	':FUNCtion1:AVERage:NUM?': '64',
	':FUNCtion1:DIFF:DX?': '4',
	':FUNCtion1:ERES:BITS?': '3.0',
	':FUNCtion1:FILTer:TYPe?': 'BPASs',
	':FUNCtion1:FILTer:HFRequency?': '1.00E+08',
	':FUNCtion1:FILTer:LFRequency?': '5.00E+07',
	':FUNCtion1:INTegrate:GATE?': 'ON',
	':FUNCtion1:INTegrate:OFFSet?': '1.00E-01',
	':FUNCtion:GVALue?': '-1.00E-07,1.00E-07',
	':FUNCtion1:INTErpolate:COEF?': '10',
	':FUNCtion1:MAXHold:SWeeps?': '100',
	':FUNCtion1:MINHold:SWeeps?': '100',
	':FUNCtion:FFTDisplay?': 'SPLit',
	':FUNCtion1:FFT:UNIT?': 'DBVrms',
	':FUNCtion1:FFT:LOAD?': '50',
	':FUNCtion1:FFT:WINDow?': 'HANNing',
	':FUNCtion1:FFT:MODE?': 'AVERage,16',
	':FUNCtion1:FFT:POINts?': '2M',
	':FUNCtion1:FFT:SPAN?': '2.00E+06',
	':FUNCtion1:FFT:HCENter?': '2.00E+06Hz',
	':FUNCtion1:FFT:HSCale?': '1.00E+08',
	':FUNCtion1:FFT:SCALe?': '2.00E+01',
	':FUNCtion1:FFT:RLEVel?': '1.00E+01',
	':FUNCtion1:FFT:SEARch?': 'PEAK',
	':FUNCtion1:FFT:SEARch:EXCursion?': '2.00E+01',
	':FUNCtion1:FFT:SEARch:THReshold?': '-1.00E+02',
	':FUNCtion1:FFT:SEARch:RESult?': 'Peaks,1,9.536743E+02,2.231755E+00;2,3.099442E+03,-8.056905E+00;',
};

const holdoffInput = { holdoff_events: 3, holdoff_time: 1.5e-8, holdoff: 'EVENts', holdoff_start: 'ACQ_START' };
const heldOffInput = { source: 'C2', coupling: 'HFREJect', noise_reject: false, ...holdoffInput };
const boundedInput = { ...heldOffInput, limit: 'INNer', time_lower: 1e-8, time_upper: 3e-8 };
const limitInput = { limit: 'INNer', time_lower: 1e-8, time_upper: 3e-8 };

const fixtures: Record<string, Array<Record<string, unknown>>> = {
	autoset_scope: [{ confirm_autoset: true }],
	calibrate_scope: [{ confirm_inputs_disconnected: true }],
	capture_screenshot: [{ include_image: false }, { inverted: true, include_image: false }],
	// The second line drives the resolution, which only the SDS2000X Plus answers; on the other family it is refused
	// before anything is sent, which is the point.
	configure_acquisition: [
		{
			mode: 'ROLL',
			capture_rate: 'FAST',
			interpolation: 'linear',
			sequence: false,
			sequence_count: 5,
			acquisition_type: 'AVERage',
			average_count: 16,
			memory_management: 'FMDepth',
			memory_depth: '10M',
			sample_rate: 1e9,
		},
		{ resolution: '10Bits' },
	],
	configure_decode: [
		{
			bus: 1,
			enabled: true,
			list: 'D1',
			list_lines: 6,
			list_scroll: 3,
			bus_enabled: true,
			protocol: 'IIC',
			format: 'HEX',
			clock_source: 'C1',
			clock_threshold: 1.5,
			data_source: 'C2',
			data_threshold: 1.5,
			read_write: true,
		},
		{
			bus: 1,
			protocol: 'SPI',
			clock_source: 'C1',
			clock_threshold: 1.5,
			mosi_source: 'C2',
			mosi_threshold: 1.5,
			miso_source: 'DIS',
			miso_threshold: 1.5,
			cs_source: 'C3',
			cs_threshold: 1.5,
			ncs_source: 'D0',
			ncs_threshold: 1.5,
			cs_type: 1e-6,
			latch_edge: 'RISing',
			bit_order: 'MSB',
			data_length: 8,
		},
		{
			bus: 1,
			protocol: 'UART',
			rx_source: 'C1',
			rx_threshold: 1.5,
			tx_source: 'DIS',
			tx_threshold: 1.5,
			baud: '9600bps',
			bit_order: 'LSB',
			parity: 'EVEN',
			stop_bits: 1.5,
			idle_level: 'HIGH',
			data_length: 8,
		},
		{ bus: 1, protocol: 'CAN', source: 'C1', threshold: 1.5, baud: '500kbps' },
		{ bus: 1, protocol: 'LIN', source: 'C1', threshold: 1.5, baud: '9600bps' },
		{ bus: 1, protocol: 'FLEXray', source: 'C1', threshold: 1.5, baud: '5Mbps' },
		{ bus: 1, protocol: 'CANFd', source: 'C1', threshold: 1.5, baud: '250kbps', data_baud: '2Mbps' },
		{
			bus: 1,
			protocol: 'IIS',
			clock_source: 'C1',
			clock_threshold: 1.5,
			ws_source: 'C2',
			ws_threshold: 1.5,
			data_source: 'C3',
			data_threshold: 1.5,
			audio_variant: 'I2S',
			latch_edge: 'RISing',
			bit_order: 'MSB',
			left_level: 'LOW',
			annotate: 'ALL',
			start_bit: 0,
			data_length: 16,
		},
		{ bus: 1, protocol: 'M1553', source: 'C1', upper_threshold: 2, lower_threshold: 1 },
		{
			bus: 1,
			protocol: 'SENT',
			source: 'C1',
			threshold: 1.5,
			message_format: 'NIBBles',
			idle_level: 'HIGH',
			crc_2010: true,
			pause_pulse: false,
			clock_period: 1e-6,
			tolerance: 5,
			nibbles: 6,
		},
		{
			bus: 1,
			protocol: 'MANchester',
			source: 'C1',
			threshold: 1.5,
			baud: 9600,
			polarity: 'RISing',
			idle_level: 'LOW',
			bit_order: 'MSB',
			display_format: 'WORD',
			idle_bits: 4,
			start_edge: 1,
			sync_size: 8,
			header_size: 8,
			trailer_size: 8,
			word_size: 8,
			data_size: 32,
		},
	],
	copy_decode_settings: [{ bus: 1, direction: 'FROMtrigger' }],
	get_decode: [{ bus: 1 }, { bus: 2 }],
	read_decode_result: [{ bus: 1 }],
	configure_channel: [
		{
			source: 'C1',
			vertical_reference: 'OFFSet',
			trace: true,
			unit: 'V',
			impedance: 'ONEMeg',
			probe_attenuation: 10,
			volts_per_div: 0.5,
			offset: -3.8,
			coupling: 'DC',
			bandwidth_limit: '20M',
			inverted: false,
			skew: 1.52e-9,
			label_text: 'VOUT',
			label: true,
			visible: true,
		},
	],
	configure_data_format: [{ precision: 'CUSTom', digits: 5 }, { precision: 'SINGle' }],
	configure_lan: [
		{ lan_type: 'STATIC', netmask: '255.255.0.0', gateway: '10.12.0.1', vnc_port: 5903, confirm_network: true },
		// The address matches the fake's own answer, so the no-op path exercises the query without a write that would
		// retire the connection under the tools that follow.
		{ address: '10.12.255.229', confirm_network: true },
	],
	configure_network_storage: [{ path: '//10.12.255.239/nfs', remember_path: true, connect: true }, { connect: false }],
	configure_system_settings: [
		{
			buzzer: true,
			clock_source: 'IN_ON',
			date: '2019-08-19',
			language: 'ENGLish',
			menu: true,
			power_on_line: false,
			remote_lock: false,
			screensaver: '10MIN',
			time: '08:10:40',
			touch_screen: true,
			autosetup_enabled: true,
			measure_enabled: true,
			cursors_enabled: true,
		},
	],
	configure_timebase: [
		{
			reference: 'DELay',
			reference_position: 20,
			time_per_div: 1e-7,
			trigger_delay: 1e-5,
			zoom_window: true,
			zoom_scale: 1e-8,
			zoom_position: 1e-3,
		},
	],
	// One call per trigger type this driver types, each writing every parameter of that type, so the conformance
	// checks below see the whole subsystem on the wire.
	configure_trigger: [
		{
			type: 'EDGE',
			source: 'EX',
			impedance: 'FIFTy',
			slope: 'ALTernate',
			level: 0.5,
			coupling: 'DC',
			noise_reject: true,
			holdoff_events: 3,
			holdoff_time: 1.5e-8,
			holdoff: 'TIME',
			holdoff_start: 'LAST_TRIG',
		},
		{ type: 'SLOPe', ...boundedInput, slope: 'RISing', level_high: 0.5, level_low: -0.5 },
		{ type: 'PULSE', ...boundedInput, source: 'D3', polarity: 'POSitive', level: 0.5 },
		{ type: 'INTerval', ...boundedInput, slope: 'RISing', level: 0.5 },
		{
			type: 'WINDow',
			...heldOffInput,
			window_type: 'RELative',
			level_high: 0.5,
			level_low: -0.5,
			center_level: 0,
			delta_level: 0.5,
		},
		{ type: 'DROPout', ...heldOffInput, dropout_type: 'EDGE', slope: 'FALLing', level: 0.5, dropout_time: 1e-8 },
		{ type: 'RUNT', ...boundedInput, polarity: 'NEGative', level_high: 0.5, level_low: -0.5 },
		{
			type: 'VIDeo',
			source: 'C2',
			standard: 'CUSTom',
			frame_rate: '50Hz',
			line_count: 800,
			field_count: 8,
			interlace: 8,
			level: 0.5,
			sync: 'SELect',
			field: 2,
			line: 100,
		},
		{
			type: 'PATTern',
			...holdoffInput,
			...limitInput,
			pattern: ['H', 'L', 'X', 'X'],
			channel_level: { source: 'C2', level: 0.5 },
			logic: 'AND',
		},
		{
			type: 'QUALified',
			...limitInput,
			edge_source: 'C1',
			edge_level: 0.5,
			edge_slope: 'RISing',
			qualify_source: 'C2',
			qualify_level: -0.5,
			qualified_type: { state: 'EDGE', option: 'RISing' },
		},
		{
			type: 'DELay',
			...limitInput,
			pattern: ['H', 'L', 'X', 'X'],
			channel_level: { source: 'C2', level: 0.5 },
			slope: 'RISing',
			source2: 'C3',
			level2: 0.5,
			slope2: 'FALLing',
			coupling: 'DC',
		},
		{
			type: 'NEDGe',
			...holdoffInput,
			source: 'C1',
			slope: 'FALLing',
			level: 0.5,
			idle_time: 1.5e-8,
			edge_count: 3,
			noise_reject: true,
		},
		{
			type: 'SHOLd',
			...limitInput,
			clock_source: 'C1',
			clock_threshold: 1.5,
			slope: 'RISing',
			data_source: 'C2',
			data_threshold: 1.5,
			data_state: 'HIGH',
			setup_hold: 'SETup',
		},
		...serialTriggers.map(({ input }) => input),
	],
	configure_trigger_mode: [{ mode: 'SINGle', action: 'stop' }],
	// One call per search mode, each writing every parameter of that mode, so the conformance checks below see the
	// whole subsystem on the wire.
	configure_search: [
		{ search: true, mode: 'EDGE', source: 'C2', slope: 'ALTernate', level: 0.5 },
		{ mode: 'SLOPe', source: 'C2', slope: 'RISing', level_high: 0.5, level_low: -0.5, ...limitInput },
		{ mode: 'PULSE', source: 'D3', polarity: 'POSitive', level: 0.5, ...limitInput },
		{ mode: 'INTerval', source: 'C2', slope: 'RISing', level: 0.5, ...limitInput },
		{ mode: 'RUNT', source: 'C2', polarity: 'NEGative', level_high: 0.5, level_low: -0.5, ...limitInput },
	],
	copy_search_settings: [{ direction: 'FROMtrigger' }],
	configure_mask_test: [
		{
			mask_test: true,
			source: 'C1',
			type: 'ALL_IN',
			display_results: true,
			buzzer_on_fail: true,
			capture_on_fail: false,
			failure_to_history: true,
			stop_on_fail: false,
			running: true,
		},
	],
	create_mask: [{ x_margin: 0.8, y_margin: 0.08, confirm_replace_mask: true }],
	load_mask: [
		{ slot: 1, confirm_replace_mask: true },
		{ file: 'local/SIGLENT/TEST.msk', confirm_replace_mask: true },
	],

	configure_advanced_measurement: [
		{ item: 1, enabled: true, type: 'SKEW', source1: 'C1', source2: 'C2' },
		{ item: 1, type: 'PKPK', source1: 'C1' },
	],
	configure_measurement_gate: [{ enabled: true, gate_a: -1e-7, gate_b: 1e-7 }],
	configure_measurement_setup: [
		{
			measurement: true,
			mode: 'ADVanced',
			simple_source: 'C1',
			advanced_items: 2,
			advanced_style: 'M1',
			amplitude_strategy: 'AUTO',
			amplitude_top: 'HISTogram',
			amplitude_base: 'HISTogram',
			threshold_source: 'C1',
			threshold_type: 'PERCent',
			threshold_absolute: { high: 3, mid: 1, low: -1.5 },
			threshold_percent: { high: 80, mid: 45, low: 10 },
		},
	],
	configure_cursors: [
		{
			cursors: true,
			mode: 'MEASure',
			measure_item: { type: 'PKPK', source1: 'C2' },
			tag_style: 'FIXed',
			source1: 'C1',
			source2: 'C2',
			x_reference: 'DELay',
			y_reference: 'OFFSet',
			x1: -1e-6,
			x2: 1e-6,
			y1: 12,
			y2: 10,
		},
	],
	configure_counter: [
		{
			counter: true,
			mode: 'TOTalizer',
			source: 'C1',
			level: 0.5,
			gate: true,
			gate_level: 0.5,
			gate_slope: 'RISing',
			gate_type: 'LEVel',
			totalizer_slope: 'RISing',
		},
		{ mode: 'FREQuency', statistics: true },
	],
	configure_dvm: [{ dvm: true, source: 'C2', mode: 'AMPLitude', auto_range: true, alarm: true, hold: false }],
	// The transparence is documented for the SHS handhelds alone, so the second call is refused before anything is
	// sent on both driven families, which is the point.
	configure_display: [
		{
			axis_labels: true,
			axis_mode: 'FIXed',
			backlight: 100,
			color_grade: true,
			grid_intensity: 50,
			grid: 'LIGHt',
			trace_intensity: 75,
			menu_style: 'FLOating',
			menu_hide: '10S',
			persistence: '5S',
			join_points: true,
		},
		{ transparence: 50 },
	],
	configure_history: [{ enabled: true, frame: 4, interval: 1e-3, list: true, list_type: 'TIME', play: 'PAUSe' }],
	get_digital: [{ lines: ['D5'] }],
	configure_digital: [
		{
			enabled: true,
			active: 'D5',
			lines: { D5: true },
			labels: { D5: 'IIC_DATA' },
			height: 6,
			position: 4,
			skew: 1e-7,
			thresholds: { d0_d7: { mode: 'CMOS' }, d8_d15: { mode: 'CUSTom', custom: 1.5 } },
			buses: { bus1: { display: true, format: 'HEX', map: ['D0', 'D3', 'D7', 'D15'] }, bus2: { default_map: true } },
		},
	],
	configure_measurement_statistics: [
		{ statistics: true, histogram: true, max_count: 1024, aim_limit: 500, reset: true },
	],
	// The refused spellings prove on the driven wire that no simple value query for them ever goes out.
	measure: [
		{ source: 'C1', parameters: ['MAX', 'PKPK'] },
		{ source: 'C1', parameter: 'RISE20T80' },
	],
	measure_delay: [{ source_a: 'C1', source_b: 'C2', type: 'PHA' }],
	read_measurement: [{}, { parameter: 'MAX' }, { parameter: 'FALL80T20' }],
	get_measurement_statistics: [{}, { item: 1, statistic: 'CURRent' }],
	get_channel: [{ source: 'C1' }],
	get_waveform: [
		{ source: 'C1', points: 4 },
		{ source: 'C1', points: 4, frame: 0, frame_start: 1 },
		{ source: 'F1', points: 4 },
	],
	// One call per operation with its own settings, so every operation-specific command reaches the wire.
	configure_math: [
		{
			function: 1,
			enabled: true,
			operation: 'AVERage',
			source1: 'C1',
			source2: 'C2',
			average_count: 64,
			inverted: false,
			scale: 1,
			position: 0.5,
			label_text: 'MATH',
			label: true,
		},
		{ operation: 'DIFF', diff_dx: 4 },
		{ operation: 'ERES', eres_bits: 3 },
		{ operation: 'FILTer', filter_type: 'BPASs', filter_upper: 1e8, filter_lower: 5e7 },
		{ operation: 'INTegrate', integrate_gate: true, gate_a: -1e-7, gate_b: 1e-7, integrate_offset: 0.1 },
		{ operation: 'INTErpolate', interpolate_factor: 10 },
		{ operation: 'MAXHold', maxhold_sweeps: 100 },
		{ operation: 'MINHold', minhold_sweeps: 100 },
	],
	// The second call carries no source, so it exercises the operation guard on the wire.
	configure_fft: [
		{
			function: 1,
			enabled: true,
			source: 'C1',
			display: 'SPLit',
			unit: 'DBVrms',
			window: 'HANNing',
			mode: 'AVERage',
			average_count: 16,
			points: '2M',
			span: 2e6,
			center_frequency: 2e6,
			vertical_scale: 20,
			reference_level: 10,
			search: 'PEAK',
			search_excursion: 20,
			search_threshold: -100,
		},
		{ unit: 'DBm', load: 50 },
	],
	// No memory query answers while the memory holds no waveform, so reads require the loaded assertion and a
	// call without it is refused with nothing sent.
	// A call without loaded: true is schema refused, covered in the unit tests, so only the asserted read drives.
	get_memory: [{ memory: 1, loaded: true }],
	configure_memory: [
		{
			memory: 1,
			loaded: true,
			horizontal_position: 1e-5,
			horizontal_scale: 1e-7,
			horizontal_sync: true,
			label: true,
			label_text: 'MEM',
			enabled: true,
			vertical_position: 0.1,
			vertical_scale: 0.1,
		},
	],
	import_memory: [
		{ source: 'C1', confirm_overwrite_memory: true },
		{ file: 'local/SIGLENT/test.bin', confirm_overwrite_memory: true },
	],
	configure_reference: [
		{
			save_source: 'C1',
			display: true,
			label: true,
			label_text: 'REFA',
			vertical_scale: 0.1,
			vertical_position: 0.2,
			confirm_overwrite_reference: true,
		},
		{ recall_file: 'U-disk0/SIGLENT/math.ref', confirm_overwrite_reference: true },
	],
	save_panel_setup: [
		{ slot: 1, confirm_overwrite: true },
		{ file: 'local/SIGLENT/default.xml', confirm_overwrite: true },
		{ default_setup: 'CUSTom', confirm_overwrite: true },
	],
	recall_panel_setup: [
		{ slot: 1, confirm_recall: true },
		{ file: 'local/SIGLENT/default.xml', confirm_recall: true },
		{ factory: true, confirm_recall: true },
	],
	erase_internal_storage: [{ confirm_erase: true }],
	save_waveform_file: [
		{ format: 'BINary', path: 'U-disk0/SIGLENT/c1.bin', source: 'C1', confirm_overwrite: true },
		{ format: 'CSV', path: 'local/SIGLENT/c1.csv', source: 'C1', include_parameters: true, confirm_overwrite: true },
		{ format: 'MATLab', path: 'net_storage/SIGLENT/c1.mat', source: 'C1', confirm_overwrite: true },
		{ format: 'REFerence', path: 'local/SIGLENT/c1.ref', source: 'C1', confirm_overwrite: true },
	],
	save_screenshot: [{ path: 'U-disk0/SIGLENT/screen.png', confirm_overwrite: true }],
	autoset_fft: [{ mode: 'NORMal' }],
	reboot_scope: [{ confirm_reboot: true }],
	reset_scope: [{ confirm_reset: true }],
	get_waveform_generator: [{}, { store: 'USER' }],
	configure_waveform_generator: [
		{
			type: 'SINE',
			frequency: 1000,
			amplitude: 2,
			offset: 0,
			arbitrary_index: 2,
			load: '50',
			sync: true,
			voltage_protection: true,
			output: true,
			confirm_output_enable: true,
		},
		{ arbitrary_name: 'wave_1', output: false },
	],
	read_meter: [{}],
	configure_meter: [
		{ meter: true, function: 'continuity' },
		{ function: 'current_ac', range: '6A', unit: 'MA', relative: true },
		{ function: 'current_dc', range: 'AUTO', unit: 'A', relative: false },
		{ function: 'diode' },
		{ function: 'resistance', range: '600', relative: true },
		{ function: 'voltage_ac', range: '60V', unit: 'V', relative: true },
		{ function: 'voltage_dc', range: '600V', unit: 'MV', relative: true },
		{ function: 'capacitance', relative: true },
		{ meter: false },
	],
	measure_meter: [
		{ function: 'continuity' },
		{ function: 'current_ac', range: '6A' },
		{ function: 'current_dc', range: '6A' },
		{ function: 'diode' },
		{ function: 'resistance', range: '600' },
		{ function: 'voltage_ac', range: '60V' },
		{ function: 'voltage_dc', range: '60V' },
		{ function: 'capacitance' },
	],
	scpi_command: [{ command: ':AUToset' }],
	scpi_query: [{ command: '*IDN?' }],
	shutdown_scope: [{ confirm_shutdown: true }],
};

const argumentsFor = (name: string): Array<Record<string, unknown>> => fixtures[name] ?? [{}];

const bmp = (() => {
	const image = Buffer.alloc(54, 0x7f);
	image.write('BM', 0, 'ascii');
	image.writeUInt32LE(image.length, 2);
	image.writeInt32LE(800, 18);
	image.writeInt32LE(480, 22);
	image.writeUInt16LE(24, 28);
	image.writeUInt32LE(0, 30);
	return image;
})();

// The guide writes an addressed node as <n>, <x>, <m> or <d>, and the wire carries the number in its place; <r> is
// the reference letter {A|B|C|D}. A bracketed node is optional, and the wire may carry it or leave it out.
const matcher = (id: string): RegExp =>
	new RegExp(
		`^${id
			.replace(/[.*+?^${}()|\\]/g, '\\$&')
			.replace(/\[([^\]]*)\]/g, '(?:$1)?')
			.replace(/<r>/g, '[A-D]')
			.replace(/<[a-z]>/g, '\\d+')}$`,
		'i',
	);

const matchers = manifest.map((entry) => [matcher(entry.id), entry] as const);

const mnemonicOf = (line: string): string => (line.split(' ')[0] ?? line).replace(/\?$/, '');

const rowFor = (line: string): CommandEntry | undefined =>
	matchers.find(([pattern]) => pattern.test(mnemonicOf(line)))?.[1];

interface Call {
	tool: string;
	exchanges: Exchange[];
	commands: unknown;
	answered: boolean;
	error?: ToolError;
}

async function driveModel(model: string): Promise<Call[]> {
	let exchanges: Exchange[] = [];
	// A 12-bit scope that starts in BYTE format, so the first transfer has to write :WAVeform:WIDTh and read the
	// descriptor again before it decodes anything.
	let format: 'BYTE' | 'WORD' = 'BYTE';
	const record: ExchangeInterceptor = (exchange, run) => {
		exchanges.push(exchange);
		return run();
	};
	const harness = await startScpiHarness(
		model,
		{
			'*OPC?': '1',
			':ACQuire:AMODe?': 'FAST',
			':ACQuire:INTerpolation?': 'OFF',
			':ACQuire:MDEPth?': '10M',
			':ACQuire:MMANagement?': 'FMDepth',
			':ACQuire:MODE?': 'ROLL',
			':ACQuire:NUMAcq?': '350',
			':ACQuire:POINts?': '1.25E+08',
			':ACQuire:RESolution?': '10Bits',
			':ACQuire:SEQuence?': 'OFF',
			':ACQuire:SEQuence:COUNt?': '5',
			':ACQuire:SRATe?': '1.00E+09',
			':ACQuire:TYPE?': 'AVERage,16',
			':CHANnel:REFerence?': 'OFFSet',
			':CHANnel1:BWLimit?': '20M',
			':CHANnel1:COUPling?': 'DC',
			':CHANnel1:IMPedance?': 'ONEMeg',
			':CHANnel1:INVert?': 'OFF',
			':CHANnel1:LABel?': 'ON',
			':CHANnel1:LABel:TEXT?': '"VOUT"',
			':CHANnel1:OFFSet?': '-3.80E+00',
			':CHANnel1:PROBe?': '1.00E+01',
			':CHANnel1:SCALe?': '5.00E-01',
			':CHANnel1:SKEW?': '1.52E-09',
			':CHANnel1:SWITch?': 'ON',
			':CHANnel1:UNIT?': 'V',
			':CHANnel1:VISible?': 'ON',
			':FORMat:DATA?': 'CUSTom,5',
			':PRINt? BMP': bmp,
			':MEMory1:HORizontal:POSition?': '1.00E-05',
			':MEMory1:HORizontal:SCALe?': '1.00E-07',
			':MEMory1:HORizontal:SYNC?': 'ON',
			':MEMory1:LABel?': 'ON',
			':MEMory1:LABel:TEXT?': '"MEM"',
			':MEMory1:SWITch?': 'ON',
			':MEMory1:VERTical:POSition?': '1.00E-01',
			':MEMory1:VERTical:SCALe?': '1.00E-01',
			':MEMory2:SWITch?': 'OFF',
			':REFA:DATA:POSition?': '2.00E-01',
			':REFA:DATA:SCALe?': '1.00E-01',
			':REFA:DATA:SOURce?': 'C1',
			':REFA:LABel?': 'ON',
			':REFA:LABel:TEXT?': '"REFA"',
			':SYSTem:BUZZer?': 'ON',
			':SYSTem:CLOCk?': 'IN_ON',
			':SYSTem:COMMunicate:LAN:GATeway?': '"10.12.0.1"',
			':SYSTem:COMMunicate:LAN:IPADdress?': '"10.12.255.229"',
			':SYSTem:COMMunicate:LAN:MAC?': '00:01:D2:0C:00:A0',
			':SYSTem:COMMunicate:LAN:SMASk?': '"255.255.0.0"',
			':SYSTem:COMMunicate:LAN:TYPE?': 'STATIC',
			':SYSTem:COMMunicate:VNCPort?': '5903',
			':SYSTem:DATE?': '20190819',
			':SYSTem:EDUMode?': 'AUTOSet,ON;MEASure,ON;CURSor,ON',
			':SYSTem:LANGuage?': 'ENGLish',
			':SYSTem:NSTorage?': '"//10.12.255.239/nfs","","***",0,0,1,0,0',
			':SYSTem:NSTorage:STATus?': 'OFF',
			':SYSTem:PON?': 'OFF',
			':SYSTem:REMote?': 'OFF',
			':SYSTem:SELFCal?': 'DONE',
			':SYSTem:SSAVer?': '10MIN',
			':SYSTem:TIME?': '081040',
			':SYSTem:TOUCh?': 'ON',
			':TIMebase:DELay?': '1.00E-05',
			':TIMebase:REFerence?': 'DELay',
			':TIMebase:REFerence:POSition?': '20',
			':TIMebase:SCALe?': '1.00E-07',
			':TIMebase:WINDow?': 'ON',
			':TIMebase:WINDow:DELay?': '1.00E-03',
			':TIMebase:WINDow:SCALe?': '1.00E-08',
			...triggerReplies,
			...searchReplies,
			...maskReplies,
			...measureReplies,
			...cursorReplies,
			...counterReplies,
			...displayReplies,
			...historyReplies,
			...digitalReplies,
			...decodeReplies,
			...dvmReplies,
			...functionReplies,
			...wgenReplies,
			...meterReplies,
			':PRINt? BMP,INVerted': bmp,
			':WAVeform:PREamble?': (socket) => {
				socket.write(block(wavedesc({ adc_bits: 12, width: format, code_per_div: 30 * 256 })));
				format = 'WORD';
			},
			':WAVeform:DATA?': block(codes([-2816, 0, 2816, 0], 'WORD')),
			':WAVeform:MAXPoint?': '10000000',
			':WAVeform:SEQuence?': '0,1',
		},
		record,
	);
	const calls: Call[] = [];
	try {
		// One call to get the connection and its handshake out of the way, so every record below holds the lines of
		// its own request and nothing else.
		await harness.client.callTool({ name: 'identify', arguments: {} });
		for (const { name } of tools) {
			for (const args of argumentsFor(name)) {
				exchanges = [];
				const result = await harness.client.callTool({ name, arguments: args });
				const body = payload(result);
				calls.push({
					tool: name,
					exchanges,
					commands: body.commands,
					answered: !result.isError,
					...(result.isError && { error: body as unknown as ToolError }),
				});
			}
		}
		return calls;
	} finally {
		await harness.close();
	}
}

describe('EN11F tools against the manifest', () => {
	let driven: Call[];

	// The SDS2000X Plus is the second family because it is the only one the guide documents :ACQuire:RESolution for,
	// so it is the only one whose handshake asks it.
	// The SHS1102X is the third because the guide documents the multimeter group and the information-bar transparence
	// for the SHS800X/SHS1000X handhelds alone, so it is the only one those tools are not refused on.
	before(async () => {
		driven = (await Promise.all(['SDS804X HD', 'SDS2104X Plus', 'SHS1102X'].map(driveModel))).flat();
	});

	const wire = (...kinds: Array<Exchange['kind']>) =>
		new Set(
			driven
				.flatMap(({ exchanges }) => exchanges)
				.filter(({ kind }) => kinds.includes(kind))
				.map(({ command }) => command),
		);

	it('never queries a command the guide gives no query form for', () => {
		const unknown: string[] = [];
		const commandOnly: string[] = [];
		for (const line of wire('query', 'binary')) {
			const entry = rowFor(line);
			if (!entry) unknown.push(line);
			else if (entry.forms === 'command') commandOnly.push(`${line} (${entry.id})`);
		}
		expect(commandOnly).toBeEqual([]);
		expect(unknown).toBeEqual([]);
	});

	it('never writes a command the guide gives no command form for', () => {
		const unknown: string[] = [];
		const queryOnly: string[] = [];
		for (const line of wire('command')) {
			const entry = rowFor(line);
			if (!entry) unknown.push(line);
			else if (entry.forms === 'query') queryOnly.push(`${line} (${entry.id})`);
		}
		expect(queryOnly).toBeEqual([]);
		expect(unknown).toBeEqual([]);
	});

	// The other half of the hang class: a headerless binary reply read with the text reader waits for a line feed
	// that never comes, and a text reply read as a block waits for a length header that never comes.
	it('reads every reply with the reader the manifest transcribes for it', () => {
		const mismatched: string[] = [];
		for (const { kind, command } of driven.flatMap(({ exchanges }) => exchanges)) {
			const entry = rowFor(command);
			if (!entry || kind === 'command') continue;
			if (kind === 'binary' && entry.response === 'text') mismatched.push(`${command} read as a block (${entry.id})`);
			if (kind === 'query' && entry.response === 'binary') mismatched.push(`${command} read as a line (${entry.id})`);
		}
		expect(mismatched).toBeEqual([]);
		expect(wire('binary').has(':PRINt? BMP')).toBeTruthy();
	});

	it('echoes lines it really wrote, on every mutating call it answered', () => {
		const mutates = new Set(tools.filter(({ annotations }) => !annotations.readOnlyHint).map(({ name }) => name));
		const silent: string[] = [];
		const invented: string[] = [];
		for (const { tool, commands, exchanges, answered } of driven) {
			if (!answered || !mutates.has(tool)) continue;
			const written = new Set(exchanges.map(({ command }) => command));
			if (!Array.isArray(commands)) silent.push(tool);
			else invented.push(...commands.filter((line) => !written.has(line)).map((line) => `${tool}: ${line}`));
		}
		expect([...new Set(silent)]).toBeEqual([]);
		expect([...new Set(invented)]).toBeEqual([]);
	});

	it('answers every driven call or refuses it before anything is sent', () => {
		for (const { answered, error, exchanges } of driven) {
			if (answered) continue;
			expect(error?.kind).toBe('unsupported');
			expect(exchanges.length).toBe(0);
		}
	});

	// The three hang gates of issue 061, each observed on an SDS1204X HD: the gated line must never reach the wire.
	it('never queries a simple measurement value for the two spellings hardware does not answer', () => {
		const offenders = driven
			.flatMap(({ exchanges }) => exchanges)
			.map(({ command }) => command)
			.filter((command) => /^:MEASure:SIMPle:VALue\? (RISE20T80|FALL80T20)/.test(command));
		expect(offenders).toBeEqual([]);
	});

	it('never queries the second cursor source outside Track mode', () => {
		// Every driven cursor fixture holds a non-Track mode, so the query may not appear at all.
		expect(wire('query').has(':CURSor:SOURce2?')).toBe(false);
		expect(wire('command').has(':CURSor:SOURce2 C2')).toBeTruthy();
	});

	it('never queries a memory without the loaded assertion', () => {
		const lines = driven
			.flatMap(({ exchanges }) => exchanges)
			.map(({ command }) => command)
			.filter((command) => command.startsWith(':MEMory2:'));
		expect(lines).toBeEqual([]);
	});

	// :WAVeform traffic engages the remote lock on its own, so every answered transfer releases it on the way out.
	it('releases the remote lock after every answered waveform transfer', () => {
		for (const { tool, answered, exchanges } of driven) {
			if (tool !== 'get_waveform' || !answered) continue;
			expect(exchanges.at(-1)?.command).toBe(':SYSTem:REMote OFF');
		}
	});

	// Both rows are branch-conditional: the driven counter fixture ends in TOTalizer mode, whose reset is
	// :COUNter:TOTalizer:RESet, and the trigger-mode fixture stops rather than runs.
	const unseen: Record<string, string> = {
		':COUNter:STATistics:RESet': 'reset_counter sends the reset of the mode in force, and the fixture is TOTalizer',
		':TRIGger:RUN': 'configure_trigger_mode takes run or stop, and the fixture stops',
	};

	it('puts every row on the wire across the driven families, or names why not', () => {
		const seen = new Set(driven.flatMap(({ exchanges }) => exchanges).map(({ command }) => mnemonicOf(command)));
		const observed = [...seen];
		const missing: string[] = [];
		for (const entry of manifest) {
			const pattern = matcher(entry.id);
			const found = observed.some((line) => pattern.test(line));
			if (entry.id in unseen) {
				expect(!found).toBeTruthy();
			} else if (!found) missing.push(entry.id);
		}
		expect(missing).toBeEqual([]);
	});

	it('drives every registered tool on at least one of the driven families', () => {
		const answered = new Set(driven.filter(({ answered: ok }) => ok).map(({ tool }) => tool));
		expect(tools.map(({ name }) => name).filter((name) => !answered.has(name))).toBeEqual([]);
	});
});
