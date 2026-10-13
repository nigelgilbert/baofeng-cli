import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SETTINGS_BASE, SETTINGS_COMMIT, SETTINGS_FIELDS, SETTINGS_SIZE, applySettings, decodeSettings, parseSettingValue } from '../src/codec.ts';
import { MAGIC, Session } from '../src/protocol.ts';
import { imageSettingsBlock, restoreImage, verifySettingsBlock, verifySettingsInFreshSession, writeSettings } from '../src/radio.ts';
import { FakeRadio } from './fake.ts';

const fixture = new Uint8Array(readFileSync(new URL('../fixtures/uv5r-hn5rv011-2026-10-12.img', import.meta.url)));
const FIXTURE_SETTINGS = { squelch: 3, save: 3, abr: 5, beep: 'on', timeout: 3, voice: 'eng', mdfa: 'name', mdfb: 'name' };
const FIELD_OFFSETS = new Set<number>(Object.values(SETTINGS_FIELDS).map((f) => f.offset));

/** Run fake timers until `p` settles and return its result. */
async function drive<T>(p: Promise<T>): Promise<T> {
  const [value] = await Promise.all([p, vi.runAllTimersAsync()]);
  return value;
}

async function startSession(radio: FakeRadio): Promise<Session> {
  const s = new Session(radio);
  await drive(s.start());
  return s;
}

/** Count handshake attempts: Session.start sends the magic one byte at a time. */
function handshakes(write: MockInstance<FakeRadio['write']>): number {
  return write.mock.calls.filter(([bytes]) => bytes.length === 1 && bytes[0] === MAGIC[0]).length;
}

describe('settings codec', () => {
  it('decodes the fixture block', () => {
    expect(decodeSettings(imageSettingsBlock(fixture))).toEqual(FIXTURE_SETTINGS);
  });
  it('decodes a zeroed block as the muted state', () => {
    expect(decodeSettings(new Uint8Array(0x20))).toMatchObject({ squelch: 0, voice: 'off', beep: 'off', abr: 0 });
  });
  it('keeps an out-of-range byte as a number', () => {
    const block = new Uint8Array(0x20);
    block[0x0e] = 7;
    expect(decodeSettings(block).voice).toBe(7);
  });
  it('parses names and menu indexes', () => {
    expect(parseSettingValue('voice', 'ENG')).toBe(1);
    expect(parseSettingValue('beep', 'on')).toBe(1);
    expect(parseSettingValue('mdfa', 'name')).toBe(2);
    expect(parseSettingValue('squelch', '9')).toBe(9);
    expect(parseSettingValue('timeout', '39')).toBe(39);
  });
  it('rejects values off the menu', () => {
    expect(() => parseSettingValue('squelch', '10')).toThrow(/0\.\.9/);
    expect(() => parseSettingValue('voice', 'french')).toThrow(/off, eng, chi/);
    expect(() => parseSettingValue('beep', '-1')).toThrow(/beep/);
  });
  it('applies a patch without touching other bytes', () => {
    const before = imageSettingsBlock(fixture);
    const out = applySettings(before, { squelch: 0, voice: 0 });
    const patched = new Set<number>([SETTINGS_FIELDS.squelch.offset, SETTINGS_FIELDS.voice.offset]);
    expect(out.length).toBe(SETTINGS_SIZE);
    expect(out[SETTINGS_FIELDS.squelch.offset]).toBe(0);
    expect(out[SETTINGS_FIELDS.voice.offset]).toBe(0);
    for (let i = 0; i < SETTINGS_SIZE; i++) {
      if (!patched.has(i)) expect(out[i], `byte 0x${i.toString(16)}`).toBe(before[i]);
    }
  });
});

describe('settings write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stages both halves and commits with the 0x0E40 record', async () => {
    const radio = new FakeRadio();
    const s = await startSession(radio);
    const block = await drive(writeSettings(s, { squelch: 0, voice: 0 }));
    expect(radio.writes).toEqual([SETTINGS_BASE, SETTINGS_BASE + 0x10, SETTINGS_COMMIT]);
    expect([...radio.eeprom.subarray(SETTINGS_BASE, SETTINGS_BASE + SETTINGS_SIZE)]).toEqual([...block]);
  });
  it('rejects the write when verified in the same session', async () => {
    const radio = new FakeRadio();
    const s = await startSession(radio);
    const block = await drive(writeSettings(s, { voice: 0 }));
    await expect(drive(verifySettingsBlock(s, block))).rejects.toMatchObject({ kind: 'device-state' });
  });
  it('waits out the idle drop and verifies the write in one new handshake', async () => {
    const radio = new FakeRadio();
    const s = await startSession(radio);
    const block = await drive(writeSettings(s, { voice: 0 }));
    const write = vi.spyOn(radio, 'write');
    expect(await drive(verifySettingsInFreshSession(radio, block))).toEqual({ ...FIXTURE_SETTINGS, voice: 'off' });
    expect(handshakes(write)).toBe(1);
  });
  it('restores the eight exposed fields of a zeroed block and leaves the other bytes zero', async () => {
    const radio = new FakeRadio();
    radio.eeprom.fill(0, SETTINGS_BASE, SETTINGS_BASE + SETTINGS_SIZE);
    const s = await startSession(radio);
    const block = await drive(writeSettings(s, { squelch: 3, save: 3, abr: 5, beep: 1, timeout: 3, voice: 1, mdfa: 2, mdfb: 2 }));
    expect([...block].filter((_, i) => !FIELD_OFFSETS.has(i)).every((b) => b === 0)).toBe(true);
    expect(await drive(verifySettingsInFreshSession(radio, block))).toEqual(FIXTURE_SETTINGS);
  });
});

describe('restore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits the settings block through the in-order write and verifies it', async () => {
    const radio = new FakeRadio();
    radio.eeprom.fill(0, SETTINGS_BASE, SETTINGS_BASE + SETTINGS_SIZE);
    const s = await startSession(radio);
    await drive(restoreImage(s, fixture));
    expect(await drive(verifySettingsInFreshSession(radio, imageSettingsBlock(fixture)))).toEqual(FIXTURE_SETTINGS);
  });
});
