import { execFile } from 'node:child_process';
import { TransportError } from './errors.ts';

export interface ListenResult {
  device: string;
  seconds: number;
  /** RMS level of each captured second in dBFS; null marks a second of digital zero. */
  rmsDbfs: (number | null)[];
  /** Count of seconds that were digital zero, as a muted device or denied microphone access produces. */
  zeroSeconds: number;
  /** Power mean of the per-second RMS levels in dBFS; null when every second is digital zero. */
  meanRmsDbfs: number | null;
  /** Highest sample peak over the captured seconds in dBFS; null when every sample is zero. */
  peakDbfs: number | null;
}

/** Per-frame astats levels; samples holds each frame's sample count when ffmpeg reports it. */
export interface Levels {
  rms: number[];
  peak: number[];
  samples: number[];
}

/** Capture sample rate; asetnsamples cuts frames of this many samples, so each frame is one second. */
const RATE = 48000;

/** High-pass corner that removes the ADC bias so levels report audio only. */
const HIGHPASS_HZ = 50;

/** ffmpeg arguments that capture `seconds` from `device`, remove DC, and print per-second astats on stderr. */
export function ffmpegArgs(device: string, seconds: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-f',
    'avfoundation',
    '-i',
    `:${device}`,
    '-t',
    String(seconds),
    '-af',
    `aformat=sample_rates=${RATE}:channel_layouts=mono,highpass=f=${HIGHPASS_HZ},asetnsamples=n=${RATE}:p=0,astats=metadata=1:reset=1,ametadata=print`,
    '-f',
    'null',
    '-',
  ];
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Round a dBFS level and map -Infinity (digital zero) to null. */
const dbfs = (x: number) => (x === -Infinity ? null : round(x));

/** Pull the per-second RMS, peak, and sample counts out of ffmpeg's stderr. */
export function parseAstats(stderr: string): Levels {
  const levels: Levels = { rms: [], peak: [], samples: [] };
  for (const [, key, value] of stderr.matchAll(/lavfi\.astats\.Overall\.(RMS_level|Peak_level|Number_of_samples)=(\S+)/g)) {
    const n = value === '-inf' ? -Infinity : Number(value);
    if (key === 'RMS_level') levels.rms.push(n);
    else if (key === 'Peak_level') levels.peak.push(n);
    else levels.samples.push(n);
  }
  return levels;
}

/** Count leading frames that hold a full second; a frame without a sample count counts as full. */
export function wholeSeconds(levels: Levels): number {
  let n = 0;
  while (n < levels.rms.length && (levels.samples[n] ?? RATE) >= RATE) n++;
  return n;
}

/** Summarize the first `seconds` frames; the caller checks that that many whole frames exist. */
export function summarize(device: string, seconds: number, levels: Levels): ListenResult {
  // ffmpeg emits frames past the requested window; keep the first `seconds` of each series.
  const rms = levels.rms.slice(0, seconds);
  const peak = levels.peak.slice(0, seconds);
  const power = rms.reduce((sum, db) => sum + 10 ** (db / 10), 0) / rms.length;
  return {
    device,
    seconds,
    rmsDbfs: rms.map(dbfs),
    zeroSeconds: rms.filter((db) => db === -Infinity).length,
    meanRmsDbfs: dbfs(10 * Math.log10(power)),
    peakDbfs: dbfs(Math.max(...peak)),
  };
}

/** Join the last three non-empty stderr lines for an error message. */
function stderrTail(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ');
}

/** Capture `seconds` of receive audio through ffmpeg and report levels. */
export function listen(device: string, seconds: number): Promise<ListenResult> {
  const timeoutMs = (seconds + 15) * 1000;
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ffmpegArgs(device, seconds), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }) | null;
      if (e?.code === 'ENOENT') {
        reject(new TransportError('ffmpeg not found on PATH; install it with brew install ffmpeg'));
        return;
      }
      const tail = stderrTail(stderr);
      const suffix = tail ? `: ${tail}` : '';
      if (e) {
        const how = e.killed && e.signal ? `timed out after ${timeoutMs / 1000}s` : e.signal ? `stopped on ${e.signal}` : `exited with code ${e.code}`;
        reject(new TransportError(`ffmpeg ${how} capturing from ${JSON.stringify(device)}${suffix}`, { device, code: e.code ?? null, signal: e.signal ?? null }));
        return;
      }
      const levels = parseAstats(stderr);
      const captured = wholeSeconds(levels);
      if (captured < seconds) {
        reject(new TransportError(`ffmpeg captured ${captured} of ${seconds} seconds from ${JSON.stringify(device)}${suffix}`, { device, captured, requested: seconds }));
        return;
      }
      resolve(summarize(device, seconds, levels));
    });
  });
}
