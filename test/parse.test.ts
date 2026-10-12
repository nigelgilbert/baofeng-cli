import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { numberFlag, parseDecimal } from '../src/args.ts';
import { parseFrequency } from '../src/codec.ts';
import { UsageError } from '../src/errors.ts';

function cli(...argv: string[]) {
  const r = spawnSync(process.execPath, ['src/main.ts', ...argv], {
    cwd: process.cwd(),
    env: { ...process.env, BAOFENG_TARGET: '/dev/null-nonexistent' },
    encoding: 'utf8',
  });
  const body = JSON.parse(r.stderr.trim()) as { kind: string; message: string };
  return { status: r.status, body };
}

describe('parseDecimal', () => {
  it('accepts plain decimals with sign, exponent and surrounding space', () => {
    expect(parseDecimal('5', 'x')).toBe(5);
    expect(parseDecimal('-0.6', 'x')).toBe(-0.6);
    expect(parseDecimal('154.68e6', 'x')).toBe(154_680_000);
    expect(parseDecimal(' 7 ', 'x')).toBe(7);
  });

  it('rejects empty, hex, Infinity and trailing junk', () => {
    for (const text of ['', ' ', '0x5', 'Infinity', '5px']) {
      expect(() => parseDecimal(text, 'x')).toThrow(UsageError);
    }
    expect(() => parseDecimal('0x5', 'channel')).toThrow('channel needs a number; got "0x5"');
  });
});

describe('numberFlag', () => {
  it('rejects a hex value', () => {
    expect(() => numberFlag(new Map([['channel', '0x5']]), 'channel')).toThrow(UsageError);
  });
});

describe('parseFrequency', () => {
  it('rejects hex', () => {
    expect(() => parseFrequency('0x9')).toThrow(UsageError);
  });
});

describe('CLI number and file errors', () => {
  it('exits 2 on an empty channel', () => {
    const { status, body } = cli('read', '', '--json');
    expect(status).toBe(2);
    expect(body.kind).toBe('usage');
  });

  it('exits 2 on a hex channel', () => {
    const { status, body } = cli('read', '0x5', '--json');
    expect(status).toBe(2);
    expect(body.kind).toBe('usage');
  });

  it('exits 2 when the restore image is missing', () => {
    const { status, body } = cli('restore', '/nonexistent/x.img', '--force', '--json');
    expect(status).toBe(2);
    expect(body.kind).toBe('usage');
    expect(body.message).toContain('cannot read');
  });
});
