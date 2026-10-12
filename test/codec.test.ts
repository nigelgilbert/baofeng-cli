import { describe, expect, it } from 'vitest';
import {
  channelToJson,
  decodeChannel,
  decodeLbcd,
  decodeName,
  decodeTone,
  encodeChannel,
  encodeLbcd,
  encodeName,
  encodeTone,
  formatMhz,
  parseFrequency,
  parseTone,
} from '../src/codec.ts';
import { UsageError } from '../src/errors.ts';

describe('lbcd', () => {
  it('round-trips the channel encoding seen on the bench radio', () => {
    // ch0 on the bench radio: 00 25 21 45 -> 452.125 MHz
    expect(decodeLbcd(Uint8Array.from([0x00, 0x25, 0x21, 0x45]))).toBe(452_125_000);
    expect([...encodeLbcd(452_125_000)]).toEqual([0x00, 0x25, 0x21, 0x45]);
    expect([...encodeLbcd(162_550_000)]).toEqual([0x00, 0x50, 0x25, 0x16]);
  });
  it('treats 0xFF as unset', () => {
    expect(decodeLbcd(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toBeUndefined();
  });
});

describe('tones', () => {
  it('encodes CTCSS as Hz*10 like the bench channels', () => {
    expect(encodeTone(parseTone('69.3'))).toBe(0x02b5);
    expect(decodeTone(0x0393)).toEqual({ kind: 'ctcss', hz: 91.5 });
  });
  it('encodes DCS as index+1 with 0x69 for inverted', () => {
    expect(encodeTone(parseTone('D023'))).toBe(1);
    expect(encodeTone(parseTone('D023I'))).toBe(1 + 0x69);
    expect(decodeTone(1 + 0x69)).toEqual({ kind: 'dcs', code: 23, inverted: true });
    expect(decodeTone(2)).toEqual({ kind: 'dcs', code: 25, inverted: false });
  });
  it('treats 0 and 0xFFFF as none', () => {
    expect(decodeTone(0)).toEqual({ kind: 'none' });
    expect(decodeTone(0xffff)).toEqual({ kind: 'none' });
  });
  it('rejects unknown DCS codes and out-of-range tones', () => {
    expect(() => parseTone('D024')).toThrow();
    expect(() => parseTone('12')).toThrow();
  });
  it('accepts standard CTCSS tones written as decimal Hz', () => {
    expect(parseTone('82.5')).toEqual({ kind: 'ctcss', hz: 82.5 });
    expect(parseTone('100')).toEqual({ kind: 'ctcss', hz: 100 });
    expect(parseTone('100.0')).toEqual({ kind: 'ctcss', hz: 100 });
    expect(parseTone('254.1')).toEqual({ kind: 'ctcss', hz: 254.1 });
  });
  it('rejects CTCSS values off the standard table or in other number forms', () => {
    for (const text of ['82.6', '0x52', '82.50', '60', '260', ' 1e2', '+82.5']) {
      expect(() => parseTone(text), text).toThrow(UsageError);
    }
    expect(() => parseTone('82.6')).toThrow('nearest 82.5, 85.4');
  });
});

describe('frequency parsing', () => {
  it('accepts MHz, Hz and exponent forms', () => {
    expect(parseFrequency('154.680')).toBe(154_680_000);
    expect(parseFrequency('154680000')).toBe(154_680_000);
    expect(parseFrequency('154.68e6')).toBe(154_680_000);
  });
  it('formats without trailing zeros', () => {
    expect(formatMhz(154_680_000)).toBe('154.68');
    expect(formatMhz(462_562_500)).toBe('462.5625');
  });
  it('rejects frequencies outside the radio bands when encoding', () => {
    expect(() => encodeChannel({ rxHz: 121_500_000 })).toThrow(/outside/);
  });
});

describe('channel records', () => {
  it('packs a simplex channel the way the bench radio stores them', () => {
    const mem = encodeChannel({ rxHz: 162_550_000 });
    expect([...mem]).toEqual([0x00, 0x50, 0x25, 0x16, 0x00, 0x50, 0x25, 0x16, 0, 0, 0, 0, 0, 0, 0, 0x44]);
  });
  it('round-trips a repeater channel with tone and narrow bandwidth', () => {
    const mem = encodeChannel({ rxHz: 146_820_000, txHz: 146_220_000, txTone: parseTone('82.5'), wide: false, lowPower: true });
    const ch = decodeChannel(mem, encodeName('BIG SKY'));
    expect(ch).toMatchObject({ rxHz: 146_820_000, txHz: 146_220_000, wide: false, lowPower: true, name: 'BIG SKY' });
    expect(ch?.txTone).toEqual({ kind: 'ctcss', hz: 82.5 });
    expect(ch?.rxTone).toEqual({ kind: 'none' });
  });
  it('reads an empty slot as undefined', () => {
    expect(decodeChannel(new Uint8Array(16).fill(0xff), new Uint8Array(16).fill(0xff))).toBeUndefined();
  });
  it('reads all-0xFF TX bytes as TX inhibited', () => {
    const mem = encodeChannel({ rxHz: 162_550_000 });
    mem.set([0xff, 0xff, 0xff, 0xff], 4);
    const ch = decodeChannel(mem, encodeName('WX'));
    expect(ch).toMatchObject({ rxHz: 162_550_000, txHz: null, name: 'WX' });
    expect(channelToJson(ch!).txMhz).toBeNull();
  });
  it('reads a record with malformed TX BCD as undefined', () => {
    const mem = encodeChannel({ rxHz: 162_550_000 });
    mem.set([0xff, 0x00, 0x00, 0x00], 4);
    expect(decodeChannel(mem, encodeName('WX'))).toBeUndefined();
  });
  it('clips names to 7 characters and pads with 0xFF', () => {
    const name = encodeName('162.550 MHz');
    expect(decodeName(name)).toBe('162.550');
    expect(name[7]).toBe(0xff);
  });
});
