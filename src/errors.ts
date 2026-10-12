import { constants } from 'node:os';

/** Error kinds; each maps to one CLI exit code. */
export type ErrorKind = 'usage' | 'transport' | 'timeout' | 'device-state' | 'busy' | 'unexpected';

export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  transport: 3,
  timeout: 4,
  deviceState: 5,
  busy: 6,
} as const;

export function exitCodeFor(kind: ErrorKind): number {
  switch (kind) {
    case 'usage':
      return EXIT.usage;
    case 'transport':
      return EXIT.transport;
    case 'timeout':
      return EXIT.timeout;
    case 'device-state':
      return EXIT.deviceState;
    case 'busy':
      return EXIT.busy;
    case 'unexpected':
      return EXIT.unexpected;
  }
}

/** Return 128 plus the signal number, the exit code for a key ended by a signal. */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

/** Base class for errors that carry a kind and a JSON-safe detail object. */
export class BaofengError extends Error {
  readonly kind: ErrorKind;
  readonly detail: Record<string, unknown>;

  constructor(kind: ErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BaofengError';
    this.kind = kind;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return { kind: this.kind, message: this.message, ...this.detail };
  }
}

export class UsageError extends BaofengError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('usage', message, detail);
  }
}

export class TransportError extends BaofengError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('transport', message, detail);
  }
}

export class TimeoutError extends BaofengError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('timeout', message, detail);
  }
}

export class DeviceStateError extends BaofengError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('device-state', message, detail);
  }
}

export class BusyError extends BaofengError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('busy', message, detail);
  }
}

export function errorKind(err: unknown): ErrorKind {
  return err instanceof BaofengError ? err.kind : 'unexpected';
}
