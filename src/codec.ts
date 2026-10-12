import { parseDecimal } from './args.ts';
import { UsageError } from './errors.ts';

/** Radio address of memory channel `n` (16 bytes each). */
export const CHANNEL_BASE = 0x0000;
/** Radio address of channel name `n` (16 bytes each, 7 used). */
export const NAME_BASE = 0x1000;
export const CHANNEL_COUNT = 128;

/** Radio addresses of the settings fields and the firmware block; CHIRP image offsets minus 8. */
export const ADDR = {
  settingsBlock: 0x0e40,
  flags: 0x0e4a,
  workmode: 0x0e4c,
  channelBlock: 0x0e70,
  mrcha: 0x0e76,
  mrchb: 0x0e77,
  firmwareBlock: 0x1ec0,
} as const;

/** Tunable range of a UV-5R in Hz. */
export const BANDS: ReadonlyArray<readonly [number, number]> = [
  [136_000_000, 174_000_000],
  [400_000_000, 520_000_000],
];

/** The DCS codes the radio knows, in the index order the ul16 tone fields use. */
export const DCS_CODES: readonly number[] = [
  23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152, 155, 156, 162, 165, 172,
  174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255, 261, 263, 265, 266, 271, 274, 306, 311, 315, 325, 331, 332, 343, 346, 351, 356,
  364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455, 462, 464, 465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624,
  627, 631, 632, 645, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754,
];

/** The 50 standard CTCSS tones in Hz, matching CHIRP's chirp_common.TONES. */
export const CTCSS_TONES: readonly number[] = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5,
  141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5,
  210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
];

/** CTCSS_TONES in tenths of a Hz for exact integer comparison. */
const CTCSS_TENTHS: readonly number[] = CTCSS_TONES.map((hz) => Math.round(hz * 10));

export type Tone = { kind: 'none' } | { kind: 'ctcss'; hz: number } | { kind: 'dcs'; code: number; inverted: boolean };

/** Parse `82.5`, `D023`, `D023I`, `none`. */
export function parseTone(text: string): Tone {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'none' || t === 'off') return { kind: 'none' };
  const dcs = /^d(\d{3})(i|n)?$/.exec(t);
  if (dcs) {
    const code = Number(dcs[1]);
    if (!DCS_CODES.includes(code)) throw new UsageError(`unknown DCS code ${dcs[1]}`);
    return { kind: 'dcs', code, inverted: dcs[2] === 'i' };
  }
  const ctcss = /^(\d{2,3})(?:\.(\d))?$/.exec(t);
  if (!ctcss) throw new UsageError(`bad tone ${JSON.stringify(text)}; use Hz like 82.5, D023, D023I or none`);
  const tenths = Number(ctcss[1]) * 10 + Number(ctcss[2] ?? '0');
  if (!CTCSS_TENTHS.includes(tenths)) {
    const below = CTCSS_TENTHS.filter((x) => x < tenths);
    const above = CTCSS_TENTHS.filter((x) => x > tenths);
    const nearest = [below[below.length - 1], above[0]].filter((x) => x !== undefined).map((x) => (x / 10).toFixed(1));
    throw new UsageError(`tone ${t} is off the CTCSS table; nearest ${nearest.join(', ')}`);
  }
  return { kind: 'ctcss', hz: tenths / 10 };
}

export function formatTone(tone: Tone): string {
  if (tone.kind === 'none') return 'none';
  if (tone.kind === 'ctcss') return tone.hz.toFixed(1);
  return `D${String(tone.code).padStart(3, '0')}${tone.inverted ? 'I' : 'N'}`;
}

/** ul16 tone field: 0 none, CTCSS as Hz*10, DCS as index+1 (+0x69 when inverted). */
export function encodeTone(tone: Tone): number {
  if (tone.kind === 'none') return 0;
  if (tone.kind === 'ctcss') return Math.round(tone.hz * 10);
  return DCS_CODES.indexOf(tone.code) + 1 + (tone.inverted ? 0x69 : 0);
}

export function decodeTone(value: number): Tone {
  if (value === 0 || value === 0xffff) return { kind: 'none' };
  if (value >= 0x0258) return { kind: 'ctcss', hz: value / 10 };
  const inverted = value > 0x69;
  const index = inverted ? value - 0x6a : value - 1;
  const code = DCS_CODES[index];
  if (code === undefined) return { kind: 'none' };
  return { kind: 'dcs', code, inverted };
}

/** Parse a frequency in MHz (`154.68`), Hz (`154680000`) or exponent form (`154.68e6`). */
export function parseFrequency(text: string): number {
  const n = parseDecimal(text, 'frequency');
  if (n <= 0) throw new UsageError(`bad frequency ${JSON.stringify(text)}`);
  const hz = n < 1000 ? Math.round(n * 1_000_000) : Math.round(n);
  if (hz % 10 !== 0) throw new UsageError(`frequency ${text} is finer than 10 Hz`);
  return hz;
}

export function checkBand(hz: number): void {
  if (!BANDS.some(([lo, hi]) => hz >= lo && hz <= hi)) {
    throw new UsageError(`${formatMhz(hz)} MHz is outside 136-174 / 400-520 MHz`);
  }
}

export function formatMhz(hz: number): string {
  return (hz / 1_000_000).toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0');
}

/** Little-endian BCD of a frequency in 10 Hz units, 4 bytes. */
export function encodeLbcd(hz: number): Uint8Array {
  let v = Math.round(hz / 10);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const lo = v % 10;
    v = Math.floor(v / 10);
    const hi = v % 10;
    v = Math.floor(v / 10);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Returns undefined for an unset (0xFF) or non-BCD field. */
export function decodeLbcd(bytes: Uint8Array): number | undefined {
  let v = 0;
  for (let i = 3; i >= 0; i--) {
    const b = bytes[i] ?? 0xff;
    const hi = b >> 4;
    const lo = b & 0x0f;
    if (hi > 9 || lo > 9) return undefined;
    v = v * 100 + hi * 10 + lo;
  }
  return v * 10;
}

export interface Channel {
  rxHz: number;
  /** Null when TX is inhibited: all four TX bytes read 0xFF. */
  txHz: number | null;
  rxTone: Tone;
  txTone: Tone;
  wide: boolean;
  lowPower: boolean;
  scan: boolean;
  bcl: boolean;
  name: string;
}

export interface ChannelSpec {
  rxHz: number;
  txHz?: number;
  rxTone?: Tone;
  txTone?: Tone;
  wide?: boolean;
  lowPower?: boolean;
  name?: string;
}

/** Pack a channel into its 16-byte memory record. */
export function encodeChannel(spec: ChannelSpec): Uint8Array {
  const txHz = spec.txHz ?? spec.rxHz;
  checkBand(spec.rxHz);
  checkBand(txHz);
  const out = new Uint8Array(16);
  out.set(encodeLbcd(spec.rxHz), 0);
  out.set(encodeLbcd(txHz), 4);
  const rx = encodeTone(spec.rxTone ?? { kind: 'none' });
  const tx = encodeTone(spec.txTone ?? { kind: 'none' });
  out[8] = rx & 0xff;
  out[9] = rx >> 8;
  out[10] = tx & 0xff;
  out[11] = tx >> 8;
  out[12] = 0;
  out[13] = 0;
  out[14] = spec.lowPower ? 1 : 0;
  // bit 6 wide, bit 2 scan; bcl and pttid stay clear.
  out[15] = ((spec.wide ?? true) ? 0x40 : 0) | 0x04;
  return out;
}

/** Pack a channel name: 7 chars, 0xFF padded, in a 16-byte record. */
export function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(16).fill(0xff);
  const text = name.toUpperCase().slice(0, 7);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

export function decodeName(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 7; i++) {
    const b = bytes[i] ?? 0xff;
    if (b === 0xff) break;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
  }
  return s.trimEnd();
}

/** Unpack a channel record; returns undefined for an empty slot or a malformed frequency, and sets txHz to null for the all-0xFF TX-inhibit marker. */
export function decodeChannel(mem: Uint8Array, name: Uint8Array): Channel | undefined {
  if (mem[0] === 0xff) return undefined;
  const rxHz = decodeLbcd(mem.subarray(0, 4));
  if (rxHz === undefined) return undefined;
  const txInhibited = mem.subarray(4, 8).every((b) => b === 0xff);
  const txHz = txInhibited ? null : decodeLbcd(mem.subarray(4, 8));
  if (txHz === undefined) return undefined;
  const flags = mem[15] ?? 0;
  return {
    rxHz,
    txHz,
    rxTone: decodeTone((mem[8] ?? 0) | ((mem[9] ?? 0) << 8)),
    txTone: decodeTone((mem[10] ?? 0) | ((mem[11] ?? 0) << 8)),
    wide: (flags & 0x40) !== 0,
    lowPower: ((mem[14] ?? 0) & 0x03) !== 0,
    scan: (flags & 0x04) !== 0,
    bcl: (flags & 0x08) !== 0,
    name: decodeName(name),
  };
}

export interface ChannelJson {
  rxMhz: string;
  txMhz: string | null;
  rxTone: string;
  txTone: string;
  bandwidth: 'wide' | 'narrow';
  power: 'high' | 'low';
  scan: boolean;
  name: string;
}

export function channelToJson(ch: Channel): ChannelJson {
  return {
    rxMhz: formatMhz(ch.rxHz),
    txMhz: ch.txHz === null ? null : formatMhz(ch.txHz),
    rxTone: formatTone(ch.rxTone),
    txTone: formatTone(ch.txTone),
    bandwidth: ch.wide ? 'wide' : 'narrow',
    power: ch.lowPower ? 'low' : 'high',
    scan: ch.scan,
    name: ch.name,
  };
}

export function checkChannelNumber(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n >= CHANNEL_COUNT) throw new UsageError(`channel must be 0..${CHANNEL_COUNT - 1}; got ${n}`);
}
