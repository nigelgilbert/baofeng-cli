import type { EventEmitter } from 'node:events';
import {
  ADDR,
  CHANNEL_BASE,
  NAME_BASE,
  SETTINGS_BASE,
  SETTINGS_COMMIT,
  SETTINGS_SIZE,
  applySettings,
  channelToJson,
  checkChannelNumber,
  decodeChannel,
  decodeSettings,
  encodeChannel,
  encodeName,
  formatMhz,
  type Channel,
  type ChannelSpec,
  type SettingName,
  type Settings,
} from './codec.ts';
import { DeviceStateError } from './errors.ts';
import { Session, hex, settle } from './protocol.ts';
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
  squelch: number | string;
  voice: number | string;
  beep: number | string;
  abr: number | string;
  note: string;
} & (ChannelPayload | { channel: number; empty: true });

/** Build the flat payload for channel `n`; an undefined record gives `empty: true`. */
export function channelPayload(n: number, ch: Channel | undefined): ChannelResult {
  if (!ch) return { channel: n, empty: true };
  const j = channelToJson(ch);
  return { channel: n, rxMhz: j.rxMhz, txMhz: j.txMhz, txTone: j.txTone, rxTone: j.rxTone, bandwidth: j.bandwidth, power: j.power, name: j.name };
}

/** Bytes of ident before main memory in a CHIRP image. */
export const IMAGE_HEADER = 8;

/** Start of the 64-byte page that holds the settings block; read it whole because 16-byte reads in 0x0E10..0x0E4F return the state page record. */
const SETTINGS_PAGE = 0x0e00;
const SETTINGS_PAGE_OFFSET = SETTINGS_BASE - SETTINGS_PAGE;

/** Read the 32-byte settings block as the radio loaded it at its last reload. */
async function readSettingsBlock(s: Session): Promise<Uint8Array> {
  const page = await s.readBlock(SETTINGS_PAGE, 0x40);
  return page.subarray(SETTINGS_PAGE_OFFSET, SETTINGS_PAGE_OFFSET + SETTINGS_SIZE);
}

export async function readSettings(s: Session): Promise<Settings> {
  return decodeSettings(await readSettingsBlock(s));
}

/**
 * Set the fields in `patch` and commit the block. The radio stages 0x0E20 and 0x0E30 in a
 * zero-filled buffer and writes it to EEPROM when a write lands at 0x0E40, so both halves
 * go every time, followed by the 0x0E40 record unchanged. Returns the block written; it
 * reads back only in a later session, see verifySettingsInFreshSession.
 */
export async function writeSettings(s: Session, patch: Partial<Record<SettingName, number>>): Promise<Uint8Array> {
  const block = applySettings(await readSettingsBlock(s), patch);
  const commit = (await s.readBlock(SETTINGS_COMMIT, 0x40)).subarray(0, 0x10);
  await s.writeBlock(SETTINGS_BASE, block.subarray(0, 0x10));
  await s.writeBlock(SETTINGS_BASE + 0x10, block.subarray(0x10, 0x20));
  await s.writeBlock(SETTINGS_COMMIT, commit);
  return block;
}

/** Read the settings block in a fresh session and fail when it differs from `expected`. */
export async function verifySettingsBlock(s: Session, expected: Uint8Array): Promise<Settings> {
  const back = await readSettingsBlock(s);
  if (hex(back) !== hex(expected)) {
    throw new DeviceStateError('settings block did not take the write', { wrote: hex(expected), read: hex(back) });
  }
  return decodeSettings(back);
}

/**
 * Wait for the radio to drop the current session and reload, start a new session on `t`,
 * and verify the settings block against `expected`. Call it after writeSettings or restoreImage.
 */
export async function verifySettingsInFreshSession(t: Transport, expected: Uint8Array): Promise<Settings> {
  await settle();
  const fresh = new Session(t);
  await fresh.start();
  return verifySettingsBlock(fresh, expected);
}

/** Read work mode, both channel numbers, the audio settings and the record on the display line in use. */
export async function readStatus(s: Session): Promise<RadioStatus> {
  const ident = s.ident ?? (await s.start());
  const settings = await readSettings(s);
  const page = await s.readBlock(ADDR.statePage, 0x40);
  const workmode = page[ADDR.workmode - ADDR.statePage] === 1 ? 'channel' : 'vfo';
  const lineB = ((page[ADDR.flags - ADDR.statePage] ?? 0) & 0x80) !== 0;
  const channelA = (page[ADDR.mrcha - ADDR.statePage] ?? 0) & 0x7f;
  const channelB = (page[ADDR.mrchb - ADDR.statePage] ?? 0) & 0x7f;
  const active = lineB ? channelB : channelA;
  const record = channelPayload(active, await readChannel(s, active));
  return {
    firmware: ident.firmware,
    workmode,
    channelA,
    channelB,
    squelch: settings.squelch,
    voice: settings.voice,
    beep: settings.beep,
    abr: settings.abr,
    ...record,
    note: STATUS_NOTE,
  };
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

/** The settings block as an image stores it, for verifySettingsBlock after a restore. */
export function imageSettingsBlock(image: Uint8Array): Uint8Array {
  return image.subarray(IMAGE_HEADER + SETTINGS_BASE, IMAGE_HEADER + SETTINGS_BASE + SETTINGS_SIZE);
}

/**
 * Write the main memory of an image back; aux memory stays untouched. The 16-byte blocks go
 * in address order, so the 0x0E40 write commits the staged settings block.
 */
export async function restoreImage(s: Session, image: Uint8Array, onProgress?: (addr: number) => void): Promise<number> {
  if (image.length < IMAGE_HEADER + 0x1800) throw new DeviceStateError(`image too short: ${image.length} bytes`);
  const ident = s.ident ?? (await s.start());
  if (hex(image.subarray(0, IMAGE_HEADER)) !== hex(ident.bytes)) {
    throw new DeviceStateError('image ident does not match this radio', { image: hex(image.subarray(0, IMAGE_HEADER)), radio: hex(ident.bytes) });
  }
  let blocks = 0;
  for (const [start, end] of RESTORE_RANGES) {
    for (let a = start; a < end; a += 0x10) {
      await s.writeBlock(a, image.subarray(IMAGE_HEADER + a, IMAGE_HEADER + a + 0x10));
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
