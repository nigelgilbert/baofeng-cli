import { MAGIC } from '../src/protocol.ts';
import type { Transport } from '../src/transport.ts';

/**
 * In-memory UV-5R: answers the clone handshake, serves 16-byte aligned reads, acks every
 * write, applies writes to channel memory and ignores writes to the VFO region, like the
 * bench radio.
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
    this.eeprom[0x0e4c] = 0;
    this.eeprom[0x0e4a] = 0x9f;
    this.eeprom.set([4, 4, 6, 0, 0, 0, 0, 0], 0x0f08);
  }

  write(bytes: Uint8Array): void {
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
        this.outbox.push(0x58, hi!, lo!, size!, ...this.eeprom.subarray(addr, addr + size!));
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
        if (addr < this.writesIgnoredBelow || addr >= this.writesIgnoredAbove) this.eeprom.set(data, addr);
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

  /** Simulate the idle timeout: the radio leaves clone mode. */
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
