import { describe, expect, it } from 'vitest';
import { ADDR, encodeChannel, encodeName } from '../src/codec.ts';
import { Session } from '../src/protocol.ts';
import { STATUS_NOTE, channelPayload, readChannel, readStatus, tune, writeChannel } from '../src/radio.ts';
import { FakeRadio } from './fake.ts';

/** Drop the clone session and start a new one, as the next CLI invocation does after the reload. */
async function nextSession(radio: FakeRadio): Promise<Session> {
  radio.dropSession();
  const s = new Session(radio);
  await s.start();
  return s;
}

describe('session', () => {
  it('handshakes and reads the firmware string', async () => {
    const radio = new FakeRadio();
    const s = new Session(radio);
    const id = await s.start();
    expect(id.firmware).toBe('HN5RV011');
    expect(id.droppedByte).toBe(true);
    expect(radio.ptt).toBe(false);
  });
  it('retries an unanswered handshake once', async () => {
    const radio = new FakeRadio();
    radio.handshakesIgnored = 1;
    const id = await new Session(radio).start();
    expect(id.firmware).toBe('HN5RV011');
  });
  it('raises device-state after two unanswered handshakes', async () => {
    const radio = new FakeRadio();
    radio.handshakesIgnored = 2;
    await expect(new Session(radio).start()).rejects.toMatchObject({ kind: 'device-state' });
  });
});

describe('channels', () => {
  it('writes and reads back a channel and its name', async () => {
    const radio = new FakeRadio();
    const s = new Session(radio);
    await s.start();
    await writeChannel(s, 5, { rxHz: 154_680_000, name: 'SHERIFF' });
    const ch = await readChannel(s, 5);
    expect(ch).toMatchObject({ rxHz: 154_680_000, txHz: 154_680_000, name: 'SHERIFF' });
    expect([...radio.eeprom.subarray(5 * 16, 5 * 16 + 16)]).toEqual([...encodeChannel({ rxHz: 154_680_000 })]);
  });
  it('reports an ignored write as a device-state error', async () => {
    const radio = new FakeRadio();
    radio.writesIgnoredBelow = 0;
    radio.writesIgnoredAbove = 0x2000;
    const s = new Session(radio);
    await s.start();
    await expect(writeChannel(s, 5, { rxHz: 154_680_000 })).rejects.toMatchObject({ kind: 'device-state' });
  });
  it('reports a TX-inhibited record with a null txMhz', async () => {
    const radio = new FakeRadio();
    const mem = encodeChannel({ rxHz: 162_550_000 });
    mem.set([0xff, 0xff, 0xff, 0xff], 4);
    radio.eeprom.set(mem, 0x0000 + 7 * 16);
    radio.eeprom.set(encodeName('WX'), 0x1000 + 7 * 16);
    const s = new Session(radio);
    await s.start();
    const ch = await readChannel(s, 7);
    expect(ch).toMatchObject({ rxHz: 162_550_000, txHz: null, name: 'WX' });
    expect(channelPayload(7, ch)).toMatchObject({ channel: 7, rxMhz: '162.55', txMhz: null, name: 'WX' });
  });
});

describe('tune', () => {
  it('writes the record and name and nothing in the settings page', async () => {
    const radio = new FakeRadio();
    const ch = await tune(radio, 5, { rxHz: 162_550_000, name: 'WX' });
    expect(ch).toMatchObject({ rxHz: 162_550_000, name: 'WX' });
    expect(radio.writes).toEqual([5 * 16, 0x1000 + 5 * 16]);
    expect(radio.writes.some((a) => a >= 0x0e40 && a <= 0x0e7f)).toBe(false);
  });
  it('leaves the channel in place after the reload', async () => {
    const radio = new FakeRadio();
    await tune(radio, 5, { rxHz: 162_550_000 });
    const ch = await readChannel(await nextSession(radio), 5);
    expect(ch).toMatchObject({ rxHz: 162_550_000, name: '162.55' });
  });
});

describe('status', () => {
  it('returns the flat payload with the note', async () => {
    const radio = new FakeRadio();
    radio.eeprom[ADDR.mrchb] = 5;
    const s = new Session(radio);
    await s.start();
    await writeChannel(s, 5, { rxHz: 154_680_000, name: 'SHERIFF' });
    const st = await readStatus(await nextSession(radio));
    expect(st).toEqual({
      firmware: 'HN5RV011',
      workmode: 'vfo',
      channelA: 0x7f,
      channelB: 5,
      channel: 5,
      rxMhz: '154.68',
      txMhz: '154.68',
      txTone: 'none',
      rxTone: 'none',
      bandwidth: 'wide',
      power: 'high',
      name: 'SHERIFF',
      note: STATUS_NOTE,
    });
    expect(STATUS_NOTE).toBe('channelA/B are the values stored in EEPROM; the radio display shows the channel the knob selected');
  });
  it('marks an empty active record', async () => {
    const radio = new FakeRadio();
    const s = new Session(radio);
    await s.start();
    const st = await readStatus(s);
    expect(st).toMatchObject({ channel: 0x7f, empty: true, note: STATUS_NOTE });
    expect(st).not.toHaveProperty('rxMhz');
  });
});
