import type { EventEmitter } from 'node:events';
import {
  ADDR,
  CHANNEL_BASE,
  NAME_BASE,
  channelToJson,
  checkChannelNumber,
  decodeChannel,
  encodeChannel,
  encodeName,
  formatMhz,
  type Channel,
  type ChannelSpec,
} from './codec.ts';
import { DeviceStateError } from './errors.ts';
import { Session, hex } from './protocol.ts';
import type { Transport } from './transport.ts';

/** Fixed explanation attached to every status payload. */
export const STATUS_NOTE = 'channelA/B are the values stored in EEPROM; the radio display shows the channel the knob selected';

/** Channel fields every channel payload carries. */
export interface ChannelPayload {
  channel: number;
  rxMhz: string;
  txMhz: string | null;
  txTone: string;
  rxTone: string;
  bandwidth: 'wide' | 'narrow';
  power: 'high' | 'low';
  name: string;
}

export type ChannelResult = ChannelPayload | { channel: number; empty: true };

export type RadioStatus = {
  firmware: string;
  workmode: 'vfo' | 'channel';
  channelA: number;
  channelB: number;
  note: string;
} & (ChannelPayload | { channel: number; empty: true });

/** Build the flat payload for channel `n`; an undefined record gives `empty: true`. */
export function channelPayload(n: number, ch: Channel | undefined): ChannelResult {
  if (!ch) return { channel: n, empty: true };
  const j = channelToJson(ch);
  return { channel: n, rxMhz: j.rxMhz, txMhz: j.txMhz, txTone: j.txTone, rxTone: j.rxTone, bandwidth: j.bandwidth, power: j.power, name: j.name };
}

/** Read work mode, both channel numbers and the record on the display line in use. */
export async function readStatus(s: Session): Promise<RadioStatus> {
  const ident = s.ident ?? (await s.start());
  const settings = await s.readBlock(ADDR.settingsBlock, 0x10);
  const channels = await s.readBlock(ADDR.channelBlock, 0x10);
  const workmode = settings[ADDR.workmode - ADDR.settingsBlock] === 1 ? 'channel' : 'vfo';
  const lineB = ((settings[ADDR.flags - ADDR.settingsBlock] ?? 0) & 0x80) !== 0;
  const channelA = (channels[ADDR.mrcha - ADDR.channelBlock] ?? 0) & 0x7f;
  const channelB = (channels[ADDR.mrchb - ADDR.channelBlock] ?? 0) & 0x7f;
  const active = lineB ? channelB : channelA;
  const record = channelPayload(active, await readChannel(s, active));
  return { firmware: ident.firmware, workmode, channelA, channelB, ...record, note: STATUS_NOTE };
}

export async function readChannel(s: Session, n: number): Promise<Channel | undefined> {
  checkChannelNumber(n);
  const mem = await s.readBlock(CHANNEL_BASE + n * 16, 0x10);
  const name = await s.readBlock(NAME_BASE + n * 16, 0x10);
  return decodeChannel(mem, name);
}

/** Write a channel record and its name; reads back the record in the same session. */
export async function writeChannel(s: Session, n: number, spec: ChannelSpec): Promise<Channel> {
  checkChannelNumber(n);
  const mem = encodeChannel(spec);
  const name = encodeName(spec.name ?? formatMhz(spec.rxHz));
  await s.writeBlock(CHANNEL_BASE + n * 16, mem);
  await s.writeBlock(NAME_BASE + n * 16, name);
  const back = await s.readBlock(CHANNEL_BASE + n * 16, 0x10);
  if (hex(back) !== hex(mem)) throw new DeviceStateError(`channel ${n} did not take the write`, { wrote: hex(mem), read: hex(back) });
  return decodeChannel(back, name)!;
}

/** Start a session and write `spec` into channel `n`; the radio applies it when the session ends. */
export async function tune(transport: Transport, n: number, spec: ChannelSpec): Promise<Channel> {
  const s = new Session(transport);
  await s.start();
  return writeChannel(s, n, spec);
}

/** Full image in CHIRP layout: 8-byte ident, main 0x0000-0x17FF, aux 0x1EC0-0x1FFF. */
export async function dumpImage(s: Session, onProgress?: (addr: number) => void): Promise<Uint8Array> {
  const ident = s.ident ?? (await s.start());
  const out: number[] = [...ident.bytes];
  for (let a = 0; a < 0x1800; a += 0x40) {
    out.push(...(await s.readBlock(a, 0x40)));
    onProgress?.(a);
  }
  if (ident.droppedByte) {
    for (let a = 0x1ec0; a < 0x1fc0; a += 0x40) out.push(...(await s.readBlock(a, 0x40)));
    for (let a = 0x1fc0; a < 0x2000; a += 0x10) out.push(...(await s.readBlock(a, 0x10)));
  } else {
    for (let a = 0x1ec0; a < 0x2000; a += 0x40) out.push(...(await s.readBlock(a, 0x40)));
  }
  return Uint8Array.from(out);
}

/** Main-memory ranges CHIRP uploads by default, as radio addresses. */
export const RESTORE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0cf0],
  [0x0d00, 0x0df0],
  [0x0e00, 0x1800],
];

/** Write the main memory of an image back; aux memory stays untouched. */
export async function restoreImage(s: Session, image: Uint8Array, onProgress?: (addr: number) => void): Promise<number> {
  if (image.length < 0x1808) throw new DeviceStateError(`image too short: ${image.length} bytes`);
  const ident = s.ident ?? (await s.start());
  if (hex(image.subarray(0, 8)) !== hex(ident.bytes)) {
    throw new DeviceStateError('image ident does not match this radio', { image: hex(image.subarray(0, 8)), radio: hex(ident.bytes) });
  }
  let blocks = 0;
  for (const [start, end] of RESTORE_RANGES) {
    for (let a = start; a < end; a += 0x10) {
      await s.writeBlock(a, image.subarray(a + 8, a + 8 + 0x10));
      blocks++;
      onProgress?.(a);
    }
  }
  return blocks;
}

/** Signals that end a key early. */
export const KEY_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface HoldResult {
  /** Seconds PTT stayed keyed, rounded to 0.1. */
  seconds: number;
  interrupted?: NodeJS.Signals;
}

/** Key PTT for `seconds`, stop early when `signals` emits SIGINT, SIGTERM or SIGHUP, and release PTT in both cases. */
export async function holdPtt(t: Transport, seconds: number, signals: EventEmitter = process): Promise<HoldResult> {
  let interrupted: NodeJS.Signals | undefined;
  let wake = () => {};
  const handlers = KEY_SIGNALS.map((signal) => {
    const handler = () => {
      if (interrupted) return;
      interrupted = signal;
      wake();
    };
    signals.on(signal, handler);
    return [signal, handler] as const;
  });
  let heldMs = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    await t.setPtt(true);
    const keyedAt = performance.now();
    if (!interrupted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, seconds * 1000);
      });
    }
    heldMs = performance.now() - keyedAt;
  } finally {
    clearTimeout(timer);
    try {
      await t.setPtt(false);
    } finally {
      for (const [signal, handler] of handlers) signals.off(signal, handler);
    }
  }
  const held = Math.round(heldMs / 100) / 10;
  return interrupted ? { seconds: held, interrupted } : { seconds: held };
}
