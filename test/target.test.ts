import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTarget } from '../src/transport.ts';

const { list } = vi.hoisted(() => ({ list: vi.fn(async (): Promise<unknown[]> => []) }));

vi.mock('serialport', () => ({ SerialPort: { list } }));

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([]);
});

describe('resolveTarget', () => {
  it('returns the given path without listing ports', async () => {
    await expect(resolveTarget('/dev/cu.x')).resolves.toBe('/dev/cu.x');
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects with a transport error when no AIOC is found', async () => {
    await expect(resolveTarget(undefined)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('returns the discovered AIOC port or its callout twin', async () => {
    list.mockResolvedValue([{ path: '/dev/tty.usbmodem1', vendorId: '1209', productId: '7388' }]);
    expect(['/dev/tty.usbmodem1', '/dev/cu.usbmodem1']).toContain(await resolveTarget(undefined));
  });
});
