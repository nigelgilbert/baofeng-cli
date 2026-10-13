import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

import { ffmpegArgs, listen, parseAstats, summarize, wholeSeconds } from '../src/audio.ts';

/** Build ametadata stderr lines for one astats frame. */
function frame(i: number, rms: string, peak: string, samples = 48000): string {
  return [
    `[Parsed_ametadata_4 @ 0x1] frame:${i}    pts:${i * 48000}   pts_time:${i}`,
    `[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.Peak_level=${peak}`,
    `[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=${rms}`,
    `[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.Number_of_samples=${samples}.000000`,
  ].join('\n');
}

const STDERR = [frame(0, '-48.965978', '-47.141749'), frame(1, '-30', '-20.5'), frame(2, '-inf', '-inf')].join('\n');

/** Make the mocked execFile call back with the given error and stderr. */
function ffmpegReturns(err: Partial<NodeJS.ErrnoException & { killed: boolean; signal: string | null }> | null, stderr: string) {
  execFile.mockImplementation((_file, _args, _opts, cb) => {
    const e = err ? Object.assign(new Error('ffmpeg failed'), err) : null;
    cb(e, '', stderr);
  });
}

describe('ffmpegArgs', () => {
  it('builds a mono 48 kHz avfoundation capture with unpadded one-second frames', () => {
    const args = ffmpegArgs('AIOC Audio', 5);
    expect(args).toContain(':AIOC Audio');
    expect(args[args.indexOf('-t') + 1]).toBe('5');
    expect(args[args.indexOf('-af') + 1]).toMatch(/sample_rates=48000:channel_layouts=mono,highpass=f=50,asetnsamples=n=48000:p=0/);
  });
});

describe('parseAstats and summarize', () => {
  it('parses per-second levels and summarizes', () => {
    const levels = parseAstats(STDERR);
    expect(levels.rms).toEqual([-48.965978, -30, -Infinity]);
    expect(levels.samples).toEqual([48000, 48000, 48000]);
    const r = summarize('AIOC Audio', 3, levels);
    expect(r).toMatchObject({ device: 'AIOC Audio', seconds: 3, rmsDbfs: [-48.97, -30, null], zeroSeconds: 1, peakDbfs: -20.5 });
    expect(r.meanRmsDbfs).toBeCloseTo(-34.72, 1);
  });
  it('trims rms and peak to the requested seconds', () => {
    const levels = parseAstats([frame(0, '-40', '-35'), frame(1, '-30', '-25'), frame(2, '-3', '-0.5')].join('\n'));
    const r = summarize('AIOC Audio', 2, levels);
    expect(r.rmsDbfs).toEqual([-40, -30]);
    expect(r.peakDbfs).toBe(-25);
  });
  it('reports null levels when every second is digital zero', () => {
    const r = summarize('AIOC Audio', 2, parseAstats([frame(0, '-inf', '-inf'), frame(1, '-inf', '-inf')].join('\n')));
    expect(r).toEqual({ device: 'AIOC Audio', seconds: 2, rmsDbfs: [null, null], zeroSeconds: 2, meanRmsDbfs: null, peakDbfs: null });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
  it('counts leading whole-second frames', () => {
    expect(wholeSeconds(parseAstats([frame(0, '-40', '-35'), frame(1, '-40', '-35', 24000)].join('\n')))).toBe(1);
    expect(wholeSeconds(parseAstats('lavfi.astats.Overall.RMS_level=-40'))).toBe(1);
    expect(wholeSeconds(parseAstats(''))).toBe(0);
  });
});

describe('listen', () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  it('reports a missing ffmpeg', async () => {
    ffmpegReturns({ code: 'ENOENT' }, '');
    await expect(listen('AIOC Audio', 2)).rejects.toMatchObject({ kind: 'transport', message: expect.stringMatching(/ffmpeg not found on PATH/) });
  });
  it('rejects a killed run even when astats output already arrived', async () => {
    const stderr = [STDERR, 'Input #0, avfoundation, from \':AIOC Audio\':', 'Exiting normally, received signal 15.'].join('\n');
    ffmpegReturns({ killed: true, signal: 'SIGTERM', code: undefined }, stderr);
    const err = await listen('AIOC Audio', 3).catch((e) => e);
    expect(err).toMatchObject({ kind: 'transport', detail: { signal: 'SIGTERM' } });
    expect(err.message).toMatch(/^ffmpeg timed out after 18s capturing from "AIOC Audio": /);
    expect(err.message).toContain('Number_of_samples=48000.000000 | Input #0, avfoundation');
    expect(err.message).toMatch(/received signal 15\.$/);
  });
  it('rejects a non-zero exit with the stderr tail', async () => {
    ffmpegReturns({ code: 1 as unknown as string }, `${frame(0, '-40', '-35')}\n[AVFoundation indev @ 0x2] Error opening input\n:AIOC Audio: Input/output error`);
    await expect(listen('AIOC Audio', 1)).rejects.toThrow(/^ffmpeg exited with code 1 capturing from "AIOC Audio": .*Error opening input \| :AIOC Audio: Input\/output error$/);
  });
  it('rejects a clean exit with fewer whole seconds than requested', async () => {
    ffmpegReturns(null, [frame(0, '-40', '-35'), frame(1, '-40', '-35'), frame(2, '-40', '-35', 12000)].join('\n'));
    const err = await listen('AIOC Audio', 3).catch((e) => e);
    expect(err).toMatchObject({ kind: 'transport', detail: { captured: 2, requested: 3 } });
    expect(err.message).toMatch(/^ffmpeg captured 2 of 3 seconds from "AIOC Audio": /);
  });
  it('rejects an empty capture with the stderr tail', async () => {
    ffmpegReturns(null, 'Stream mapping:\n  Stream #0:0 -> #0:0 (pcm_f32le (native) -> pcm_s16le (native))\nPress [q] to stop');
    await expect(listen('AIOC Audio', 2)).rejects.toThrow(/^ffmpeg captured 0 of 2 seconds from "AIOC Audio": Stream mapping: \| .* \| Press \[q\] to stop$/);
  });
  it('summarizes a successful run and drops the frame past the window', async () => {
    ffmpegReturns(null, [STDERR, frame(3, '-1', '-0.1')].join('\n'));
    const r = await listen('AIOC Audio', 3);
    expect(r).toMatchObject({ rmsDbfs: [-48.97, -30, null], zeroSeconds: 1, peakDbfs: -20.5 });
    const [file, args, opts] = execFile.mock.calls[0]!;
    expect(file).toBe('ffmpeg');
    expect(args).toEqual(ffmpegArgs('AIOC Audio', 3));
    expect(opts).toMatchObject({ timeout: 18000 });
  });
});
