import { existsSync } from 'node:fs';
import { SerialPort } from 'serialport';
import { BusyError, TransportError } from './errors.ts';

/** Set BAOFENG_DEBUG=1 to log every byte on stderr. */
const DEBUG = process.env.BAOFENG_DEBUG === '1';

/** AIOC USB ids; used to find the port when no target is given. */
export const AIOC_VENDOR_ID = '1209';
export const AIOC_PRODUCT_ID = '7388';

/** Byte source and sink; the protocol layer reads through `read`. */
export interface Transport {
  readonly target: string;
  write(bytes: Uint8Array): void;
  /** Read exactly `n` bytes, or fewer when `ms` elapses first. */
  read(n: number, ms: number): Promise<Uint8Array>;
  /** Drop any bytes received so far. */
  discard(): void;
  /** Drive the AIOC PTT line: DTR high with RTS low keys the radio. */
  setPtt(on: boolean): Promise<void>;
  close(): Promise<void>;
}

/** Find the AIOC CDC port; prefers the callout device on macOS. */
export async function findAioc(): Promise<string | undefined> {
  const ports = await SerialPort.list();
  const aioc = ports.find((p) => (p.vendorId ?? '').toLowerCase() === AIOC_VENDOR_ID && (p.productId ?? '').toLowerCase() === AIOC_PRODUCT_ID);
  if (!aioc) return undefined;
  const callout = aioc.path.replace('/dev/tty.', '/dev/cu.');
  return existsSync(callout) ? callout : aioc.path;
}

/** Return the given path, or the discovered AIOC port, or throw a TransportError when neither exists. */
export async function resolveTarget(given: string | undefined): Promise<string> {
  if (given) return given;
  const found = await findAioc();
  if (!found) throw new TransportError('no AIOC found; pass --target /dev/cu.usbmodemXXXX or set BAOFENG_TARGET');
  return found;
}

/** The only module that imports `serialport`; opens the port at 9600 8N1 with PTT released. */
export class SerialTransport implements Transport {
  readonly target: string;
  private readonly port: SerialPort;
  private buf: number[] = [];
  private failure: TransportError | undefined;
  private closing = false;

  private constructor(path: string, port: SerialPort) {
    this.target = path;
    this.port = port;
    port.on('data', (chunk: Buffer) => {
      if (DEBUG) process.stderr.write(`rx ${Date.now() % 100000} ${chunk.toString('hex')}\n`);
      this.buf.push(...chunk);
    });
    port.on('error', (err: Error) => this.fail(`serial error: ${err.message}`));
    // The stream emits `close` with a DisconnectedError when the device goes away.
    port.on('close', (err?: Error | null) => this.fail(err ? `device disconnected: ${err.message}` : 'device disconnected'));
  }

  /** Record the first failure seen while the port is in use; later reads, writes and PTT calls reject with it. */
  private fail(message: string): void {
    if (this.closing || this.failure) return;
    if (DEBUG) process.stderr.write(`fail ${Date.now() % 100000} ${message}\n`);
    this.failure = new TransportError(message, { target: this.target });
  }

  static async open(path: string): Promise<SerialTransport> {
    if (!existsSync(path)) throw new TransportError(`no device at ${path}`, { target: path });
    const port = new SerialPort({ path, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false, lock: true });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (!err) return resolve();
        if (/lock|busy|resource/i.test(err.message)) reject(new BusyError(`cannot open ${path}: ${err.message}`, { target: path }));
        else reject(new TransportError(`cannot open ${path}: ${err.message}`, { target: path }));
      });
    });
    const t = new SerialTransport(path, port);
    // Opening a tty raises DTR; release PTT before the radio sees it.
    await t.setPtt(false);
    return t;
  }

  write(bytes: Uint8Array): void {
    if (DEBUG) process.stderr.write(`tx ${Date.now() % 100000} ${Buffer.from(bytes).toString('hex')}\n`);
    if (this.failure) throw this.failure;
    this.port.write(Buffer.from(bytes), (err) => {
      if (err) this.fail(`write failed: ${err.message}`);
    });
  }

  async read(n: number, ms: number): Promise<Uint8Array> {
    const deadline = Date.now() + ms;
    while (this.buf.length < n && Date.now() < deadline) {
      if (this.failure) throw this.failure;
      await new Promise((r) => setTimeout(r, 2));
    }
    if (this.failure) throw this.failure;
    return Uint8Array.from(this.buf.splice(0, n));
  }

  discard(): void {
    this.buf = [];
  }

  setPtt(on: boolean): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.port.set({ dtr: on, rts: false }, (err) => (err ? reject(new TransportError(err.message, { target: this.target })) : resolve()));
    });
  }

  close(): Promise<void> {
    if (!this.port.isOpen) return Promise.resolve();
    this.closing = true;
    return new Promise((resolve) => this.port.close(() => resolve()));
  }
}
