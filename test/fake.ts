import { MAGIC } from '../src/protocol.ts';
import type { Transport } from '../src/transport.ts';

/** Start of the page the radio serves from its reload snapshot and aliases for 16-byte reads. */
const PAGE = 0x0e00;
const PAGE_END = 0x0e80;
const SETTINGS = 0x0e20;
const COMMIT = 0x0e40;
/** Silence after which the bench radio leaves clone mode, measured at about 2.5 s. */
const IDLE_DROP_MS = 2500;

/**
 * In-memory UV-5R with the bench radio's behaviour: answers the clone handshake, serves
 * 16-byte aligned reads, acks every write, applies writes to channel memory and ignores
 * writes to the VFO region. The 0x0E00 page reads as it was at the last reload; 16-byte
 * reads in 0x0E10..0x0E4F return the 0x0E40 record; writes at 0x0E20 and 0x0E30 are staged
 * in a zero-filled buffer that a write at 0x0E40 commits.
 *
 * Assumptions beyond the bench measurements:
 * - The bench showed writes to 0x0E4C and 0x0E76..0x0E77 have no effect. The fake drops
 *   every other write in 0x0E00..0x0E7F too, including the bytes of the 0x0E40 write itself.
 * - The session drops after IDLE_DROP_MS without a byte from the host, timed with
 *   Date.now(), so fake timers drive it. A handshake then starts a new session and reloads
 *   the page.
 */
export class FakeRadio implements Transport {
  readonly target = 'fake';
  readonly eeprom = new Uint8Array(0x2000).fill(0xff);
  readonly ident = Uint8Array.from([0xaa, 0x30, 0x76, 0x04, 0x00, 0x05, 0x20, 0xdd]);
  private inbox: number[] = [];
  private outbox: number[] = [];
  private magicSeen = 0;
  private state: 'idle' | 'acked' | 'ident-sent' | 'session' = 'idle';
  private pendingAckForRead = false;
  private loadedPage = new Uint8Array(PAGE_END - PAGE);
  private staged = new Uint8Array(0x20);
  private lastByteAt = 0;
  ptt = false;
  /** Addresses of every write command the radio received, in order. */
  readonly writes: number[] = [];
  /** Number of magic sequences to leave unanswered, as a radio still in a dying clone session. */
  handshakesIgnored = 0;
  writesIgnoredBelow = 0x0f00;
  writesIgnoredAbove = 0x0f40;

  constructor() {
    this.eeprom.set(Buffer.from('HN5RV011', 'latin1'), 0x1ec0 + 48);
    this.eeprom[0x1fcf] = 0xff;
    this.eeprom.set(
      [0x03, 0, 0, 0x03, 0, 0, 0x05, 0, 0x01, 0x03, 0, 0, 0, 0, 0x01, 0, 0x03, 0, 0, 0, 0x05, 0x02, 0x02, 0, 0, 0, 0, 0, 0, 0x03, 0x01, 0x02],
      SETTINGS,
    );
    this.eeprom[0x0e4c] = 0;
    this.eeprom[0x0e4a] = 0x9f;
    this.eeprom.set([4, 4, 6, 0, 0, 0, 0, 0], 0x0f08);
    this.reload();
  }

  /** Load the 0x0E00 page from EEPROM and clear the staging buffer, as the radio does when it enters clone mode. */
  private reload(): void {
    this.loadedPage = Uint8Array.from(this.eeprom.subarray(PAGE, PAGE_END));
    this.staged.fill(0);
  }

  write(bytes: Uint8Array): void {
    if (this.state !== 'idle' && Date.now() - this.lastByteAt >= IDLE_DROP_MS) this.dropSession();
    this.lastByteAt = Date.now();
    for (const b of bytes) this.feed(b);
  }

  private feed(b: number): void {
    if (this.state === 'idle') {
      if (b === MAGIC[this.magicSeen]) {
        this.magicSeen++;
        if (this.magicSeen === MAGIC.length) {
          this.magicSeen = 0;
          if (this.handshakesIgnored > 0) {
            this.handshakesIgnored--;
            return;
          }
          this.state = 'acked';
          this.reload();
          this.outbox.push(0x06);
        }
      } else this.magicSeen = 0;
      return;
    }
    if (this.state === 'acked') {
      if (b === 0x02) {
        this.outbox.push(...this.ident);
        this.state = 'ident-sent';
      }
      return;
    }
    if (this.state === 'ident-sent') {
      if (b === 0x06) {
        this.outbox.push(0x06);
        this.state = 'session';
      }
      return;
    }
    this.inbox.push(b);
    this.drain();
  }

  private serve(addr: number, size: number): Uint8Array {
    if (addr >= PAGE && addr < PAGE_END) {
      const at = size === 0x10 && addr >= 0x0e10 && addr < 0x0e50 ? COMMIT : addr;
      return this.loadedPage.subarray(at - PAGE, at - PAGE + size);
    }
    return this.eeprom.subarray(addr, addr + size);
  }

  private store(addr: number, data: number[]): void {
    if (addr === SETTINGS || addr === SETTINGS + 0x10) {
      this.staged.set(data, addr - SETTINGS);
      return;
    }
    if (addr === COMMIT) {
      this.eeprom.set(this.staged, SETTINGS);
      this.staged.fill(0);
      return;
    }
    if (addr >= PAGE && addr < PAGE_END) return;
    if (addr < this.writesIgnoredBelow || addr >= this.writesIgnoredAbove) this.eeprom.set(data, addr);
  }

  private drain(): void {
    while (this.inbox.length > 0) {
      const cmd = this.inbox[0]!;
      if (cmd === 0x06) {
        this.inbox.shift();
        continue;
      }
      if (cmd === 0x53) {
        if (this.inbox.length < 4) return;
        const [, hi, lo, size] = this.inbox.splice(0, 4) as number[];
        const addr = ((hi! << 8) | lo!) & ~0x0f;
        if (this.pendingAckForRead) this.outbox.push(0x06);
        this.pendingAckForRead = true;
        this.outbox.push(0x58, hi!, lo!, size!, ...this.serve(addr, size!));
        continue;
      }
      if (cmd === 0x58) {
        if (this.inbox.length < 4) return;
        const len = this.inbox[3]!;
        if (this.inbox.length < 4 + len) return;
        const [, hi, lo] = this.inbox.splice(0, 4) as number[];
        const data = this.inbox.splice(0, len);
        const addr = (hi! << 8) | lo!;
        this.writes.push(addr);
        this.store(addr, data);
        this.outbox.push(0x06);
        continue;
      }
      this.inbox.shift();
    }
  }

  async read(n: number, _ms: number): Promise<Uint8Array> {
    return Uint8Array.from(this.outbox.splice(0, n));
  }

  discard(): void {
    this.outbox = [];
  }

  /** Leave clone mode at once, as the radio does after IDLE_DROP_MS of silence. */
  dropSession(): void {
    this.state = 'idle';
    this.inbox = [];
    this.outbox = [];
    this.pendingAckForRead = false;
  }

  async setPtt(on: boolean): Promise<void> {
    this.ptt = on;
  }

  async close(): Promise<void> {}
}
