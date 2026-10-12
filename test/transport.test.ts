import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportError } from '../src/errors.ts';
import { SerialTransport } from '../src/transport.ts';

type Cb = (err?: Error | null) => void;

/** Stand-in for the serialport stream; tests drive it through `ports` and its fields. */
const { FakePort, ports } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const ports: InstanceType<typeof FakePort>[] = [];
  class FakePort extends EventEmitter {
    static list = async (): Promise<unknown[]> => [];
    isOpen = false;
    writeError: Error | undefined;
    written: Buffer[] = [];
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      ports.push(this);
    }
    open(cb: Cb): void {
      this.isOpen = true;
      process.nextTick(() => cb(null));
    }
    write(buf: Buffer, cb: Cb): boolean {
      this.written.push(buf);
      const err = this.writeError;
      process.nextTick(() => cb(err ?? null));
      return true;
    }
    set(_opts: unknown, cb: Cb): void {
      process.nextTick(() => cb(null));
    }
    close(cb: Cb): void {
      this.isOpen = false;
      process.nextTick(() => {
        this.emit('close', null);
        cb(null);
      });
    }
  }
  return { FakePort, ports };
});

vi.mock('serialport', () => ({ SerialPort: FakePort }));

/** Open a transport on `/dev/null` so the existence check passes, and return it with its fake port. */
async function openFake() {
  const t = await SerialTransport.open('/dev/null');
  const port = ports.at(-1)!;
  return { t, port };
}

beforeEach(() => {
  ports.length = 0;
});

describe('SerialTransport', () => {
  it('buffers data events and returns them from read', async () => {
    const { t, port } = await openFake();
    port.emit('data', Buffer.from([1, 2, 3]));
    setTimeout(() => port.emit('data', Buffer.from([4])), 10);
    expect(Array.from(await t.read(4, 500))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await t.read(1, 20))).toEqual([]);
  });

  it('rejects a pending read promptly after an error event and throws on the next write', async () => {
    const { t, port } = await openFake();
    const start = Date.now();
    setTimeout(() => port.emit('error', new Error('EIO')), 20);
    const err = await t.read(1, 2000).catch((e: unknown) => e);
    expect(Date.now() - start).toBeLessThan(500);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toContain('EIO');
    expect((err as TransportError).detail).toEqual({ target: '/dev/null' });
    expect(() => t.write(Uint8Array.of(0x50))).toThrow(TransportError);
    await expect(t.setPtt(false)).rejects.toBeInstanceOf(TransportError);
  });

  it('rejects the next read after a write callback reports an error', async () => {
    const { t, port } = await openFake();
    port.writeError = new Error('write EIO');
    t.write(Uint8Array.of(0x50));
    const err = await t.read(1, 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toContain('write EIO');
  });

  it('marks the transport failed when the device disconnects', async () => {
    const { t, port } = await openFake();
    port.isOpen = false;
    port.emit('close', new Error('Device not configured'));
    const err = await t.read(1, 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toContain('disconnected');
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('treats a deliberate close as normal', async () => {
    const { t } = await openFake();
    await expect(t.close()).resolves.toBeUndefined();
    expect(Array.from(await t.read(1, 20))).toEqual([]);
    expect(() => t.write(Uint8Array.of(0x50))).not.toThrow();
    await expect(t.close()).resolves.toBeUndefined();
  });
});
