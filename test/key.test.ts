import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signalExitCode } from '../src/errors.ts';
import { KEY_SIGNALS, holdPtt } from '../src/radio.ts';
import type { Transport } from '../src/transport.ts';
import { FakeRadio } from './fake.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function listeners(em: EventEmitter): number {
  return KEY_SIGNALS.reduce((n, s) => n + em.listenerCount(s), 0);
}

describe('holdPtt', () => {
  it('keys for the given time, releases PTT and removes its listeners', async () => {
    const radio = new FakeRadio();
    const em = new EventEmitter();
    const pending = holdPtt(radio, 0.1, em);
    await Promise.resolve();
    expect(radio.ptt).toBe(true);
    expect(listeners(em)).toBe(3);
    const result = await pending;
    expect(result.interrupted).toBeUndefined();
    expect(result.seconds).toBeGreaterThanOrEqual(0.1);
    expect(result.seconds).toBeLessThan(0.5);
    expect(radio.ptt).toBe(false);
    expect(listeners(em)).toBe(0);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('releases PTT early on %s', async (signal) => {
    const radio = new FakeRadio();
    const em = new EventEmitter();
    const started = performance.now();
    const pending = holdPtt(radio, 5, em);
    setTimeout(() => em.emit(signal), 50);
    const result = await pending;
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.interrupted).toBe(signal);
    expect(result.seconds).toBeLessThan(0.5);
    expect(radio.ptt).toBe(false);
    expect(listeners(em)).toBe(0);
  });

  it('handles the first of two signals', async () => {
    const radio = new FakeRadio();
    const em = new EventEmitter();
    const pending = holdPtt(radio, 5, em);
    setTimeout(() => {
      em.emit('SIGINT');
      em.emit('SIGTERM');
    }, 50);
    const result = await pending;
    expect(result.interrupted).toBe('SIGINT');
    expect(radio.ptt).toBe(false);
  });

  it('throws the release error and removes its listeners', async () => {
    const em = new EventEmitter();
    const radio: Transport = Object.assign(new FakeRadio(), {
      async setPtt(on: boolean): Promise<void> {
        if (!on) throw new Error('release failed');
      },
    });
    const pending = holdPtt(radio, 5, em);
    setTimeout(() => em.emit('SIGINT'), 50);
    await expect(pending).rejects.toThrow('release failed');
    expect(listeners(em)).toBe(0);
  });
});

describe('signalExitCode', () => {
  it('adds 128 to the signal number', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
  });
});

describe('key verb', () => {
  it('exits 3 with a transport error when the target does not exist', () => {
    const res = spawnSync(process.execPath, [MAIN, 'key', '--seconds', '5', '--json'], {
      env: { ...process.env, BAOFENG_TARGET: '/dev/does-not-exist-baofeng' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(JSON.parse(res.stderr.trim())).toMatchObject({ kind: 'transport' });
  });
});
