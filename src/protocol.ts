import { ADDR } from './codec.ts';
import { DeviceStateError, TimeoutError } from './errors.ts';
import type { Transport } from './transport.ts';

/** Clone-mode magic for the UV-5R family (CHIRP UV5R_MODEL_291). */
export const MAGIC = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x12, 0x07, 0x25]);
const ACK = 0x06;
const CMD_READ = 0x53; // 'S'
const CMD_WRITE = 0x58; // 'X'
const REPLY = 0x58; // 'X'

/** The radio leaves clone mode after this much silence; a session past it needs a new handshake. */
export const IDLE_LIMIT_MS = 2500;
/** Silence to wait before a new handshake so the radio has left clone mode and reloaded its settings. */
export const SETTLE_MS = 3000;
/** Try the handshake once more after a pause when the radio does not ack. */
const HANDSHAKE_ATTEMPTS = 2;
/** A previous verb may have left the radio in clone mode; this much silence drops it. */
const HANDSHAKE_RETRY_MS = SETTLE_MS;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const hex = (a: Uint8Array | number[]): string => [...a].map((b) => b.toString(16).padStart(2, '0')).join(' ');

export interface Ident {
  bytes: Uint8Array;
  firmware: string;
  droppedByte: boolean;
}

/**
 * One clone-mode session. Commands go back to back; the radio drops the session after
 * IDLE_LIMIT_MS of silence and reloads its settings from EEPROM when it does.
 */
export class Session {
  private lastCommandAt = 0;
  private commands = 0;
  ident: Ident | undefined;

  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Send the magic, read the ident, then read the firmware block the way CHIRP does. */
  async start(): Promise<Ident> {
    let bytes: Uint8Array | undefined;
    let lastGot = '';
    for (let attempt = 0; attempt < HANDSHAKE_ATTEMPTS && !bytes; attempt++) {
      if (attempt > 0) await sleep(HANDSHAKE_RETRY_MS);
      this.transport.discard();
      for (const b of MAGIC) {
        this.transport.write(Uint8Array.of(b));
        await sleep(10);
      }
      const ack = await this.transport.read(1, 1200);
      if (ack[0] !== ACK) {
        lastGot = hex(ack);
        continue;
      }
      this.transport.write(Uint8Array.of(0x02));
      await sleep(300);
      let id = await this.transport.read(12, 50);
      if (id.length === 12) id = Uint8Array.from([id[0]!, id[3]!, id[5]!, ...id.subarray(7)]);
      if (id.length !== 8) throw new DeviceStateError('unexpected ident from radio', { got: hex(id) });
      this.transport.write(Uint8Array.of(ACK));
      const ack2 = await this.transport.read(1, 1000);
      if (ack2[0] !== ACK) throw new DeviceStateError('radio refused the clone session', { got: hex(ack2) });
      bytes = id;
    }
    if (!bytes) {
      throw new DeviceStateError('radio did not answer the clone handshake; check the radio is on and the cable is seated', { got: lastGot });
    }
    this.lastCommandAt = Date.now();
    this.commands = 0;
    // A first read outside the aux area, then the firmware block; newer radios need this order.
    await this.readBlock(0x1e80, 0x40);
    const fw = await this.readBlock(ADDR.firmwareBlock, 0x40);
    const tail = await this.readBlock(0x1fc0, 0x40);
    const firmware = Buffer.from(fw.subarray(48, 62))
      .toString('latin1')
      .replace(/[^\x20-\x7e]/g, '')
      .trim();
    this.ident = { bytes, firmware, droppedByte: tail[15] === 0xff };
    return this.ident;
  }

  private touch(): void {
    const gap = Date.now() - this.lastCommandAt;
    if (this.commands > 0 && gap > IDLE_LIMIT_MS - 300) {
      throw new DeviceStateError(`clone session idle for ${gap} ms; the radio has left clone mode`, { idleMs: gap });
    }
    this.lastCommandAt = Date.now();
    this.commands++;
  }

  /** Read `size` bytes at `addr`; the radio serves 16-byte aligned blocks, so pass aligned addresses. */
  async readBlock(addr: number, size: number): Promise<Uint8Array> {
    const first = this.commands === 0;
    this.touch();
    this.transport.write(Uint8Array.of(CMD_READ, addr >> 8, addr & 0xff, size));
    if (!first) {
      const ack = await this.transport.read(1, 1500);
      if (ack[0] !== ACK) throw new TimeoutError(`no ack before read of 0x${addr.toString(16)}`, { addr, got: hex(ack) });
    }
    const hdr = await this.transport.read(4, 1500);
    if (hdr.length < 4 || hdr[0] !== REPLY || ((hdr[1]! << 8) | hdr[2]!) !== addr || hdr[3] !== size) {
      throw new DeviceStateError(`bad read header at 0x${addr.toString(16)}`, { addr, got: hex(hdr) });
    }
    const data = await this.transport.read(size, 3000);
    if (data.length !== size) throw new TimeoutError(`short read at 0x${addr.toString(16)}: ${data.length}/${size}`, { addr });
    this.transport.write(Uint8Array.of(ACK));
    await sleep(50);
    return data;
  }

  /** Write one 16-byte aligned block. The radio acks every write; only some regions take effect. */
  async writeBlock(addr: number, data: Uint8Array): Promise<void> {
    this.touch();
    this.transport.discard();
    this.transport.write(Uint8Array.from([CMD_WRITE, addr >> 8, addr & 0xff, data.length, ...data]));
    await sleep(50);
    const ack = await this.transport.read(1, 1500);
    if (ack[0] !== ACK) throw new DeviceStateError(`radio refused write at 0x${addr.toString(16)}`, { addr, got: hex(ack) });
  }
}
