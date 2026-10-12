#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { checkFlags, numberFlag, parseArgs, parseDecimal, stringFlag, type ParsedArgs } from './args.ts';
import { checkBand, checkChannelNumber, parseFrequency, parseTone, type ChannelSpec } from './codec.ts';
import { BaofengError, EXIT, UsageError, errorKind, exitCodeFor, signalExitCode } from './errors.ts';
import { Session } from './protocol.ts';
import { channelPayload, dumpImage, holdPtt, readChannel, readStatus, restoreImage, tune, type ChannelResult, type RadioStatus } from './radio.ts';
import { SerialTransport, resolveTarget, type Transport } from './transport.ts';

interface Verb {
  summary: string;
  run: (args: ParsedArgs) => Promise<number>;
}

const BOOLEAN_FLAGS = new Set(['json', 'text', 'help', 'narrow', 'low-power', 'force']);
const COMMON = ['json', 'text', 'target'];
const TUNE_FLAGS = ['channel', 'offset', 'tone', 'rx-tone', 'narrow', 'low-power', 'name'];
const MAX_KEY_SECONDS = 60;
/** Seconds after the command ends until the radio reloads and applies a write. */
const APPLIES_AFTER_SECONDS = 3;

const verbs: Record<string, Verb> = {
  status: { summary: 'Print firmware, work mode, stored channel numbers and the active record: status', run: statusVerb },
  tune: { summary: 'Write a frequency into the channel the radio shows: tune 154.680 --channel 5 --tone 82.5', run: tuneVerb },
  read: { summary: 'Print one channel record: read 5', run: readVerb },
  key: { summary: 'Key the transmitter for S seconds: key --seconds 2', run: keyVerb },
  dump: { summary: 'Save the full memory image: dump --out radio.img', run: dumpVerb },
  restore: { summary: 'Write the main memory of an image back: restore radio.img --force', run: restoreVerb },
};

function helpText(): string {
  const width = Math.max(...Object.keys(verbs).map((v) => v.length));
  const rows = Object.entries(verbs).map(([name, v]) => `  ${name.padEnd(width)}  ${v.summary}`);
  return [
    'usage: baofeng <verb> [options]',
    '',
    'verbs:',
    ...rows,
    '',
    'options:',
    '  --json             print JSON (default when stdout is not a terminal)',
    '  --text             print text',
    '  --target PATH      serial device (default: BAOFENG_TARGET, else the AIOC found by USB id)',
    '  --channel N        tune: channel to write, 0..127, as shown on the radio display (required)',
    '  --offset MHZ       tune: repeater offset, signed: --offset -0.6',
    '  --tone HZ          tune: TX CTCSS in Hz (82.5), DCS (D023, D023I) or none',
    '  --rx-tone HZ       tune: RX tone; default none (carrier squelch)',
    '  --narrow           tune: 12.5 kHz bandwidth (default wide)',
    '  --low-power        tune: low TX power',
    '  --name TEXT        tune: channel name, 7 chars (default the frequency)',
    '  --seconds S        key: hold time, 0 < S <= 60 (required)',
    '  --out FILE         dump: output path (default uv5r-YYYY-MM-DDTHH-MM-SS.img)',
    '  --force            restore: confirm a bulk write',
    '',
    'exit codes: 0 ok, 1 unexpected, 2 usage, 3 transport, 4 timeout, 5 device-state, 6 busy, 128+signal key interrupted',
  ].join('\n');
}

/** Pick JSON for --json or a non-terminal stdout, and text for --text or a terminal. */
function wantsJson(flags: Map<string, string | true>): boolean {
  if (flags.get('json')) return true;
  if (flags.get('text')) return false;
  return !process.stdout.isTTY;
}

async function withTransport<T>(flags: Map<string, string | true>, fn: (t: Transport) => Promise<T>): Promise<T> {
  const target = await resolveTarget(stringFlag(flags, 'target') ?? process.env.BAOFENG_TARGET);
  const transport = await SerialTransport.open(target);
  try {
    return await fn(transport);
  } finally {
    await transport.close();
  }
}

function print(args: ParsedArgs, json: object, text: () => string): void {
  if (wantsJson(args.flags)) process.stdout.write(`${JSON.stringify(json)}\n`);
  else process.stdout.write(`${text()}\n`);
}

function channelSpec(freqText: string, flags: Map<string, string | true>): ChannelSpec {
  const rxHz = parseFrequency(freqText);
  const offset = numberFlag(flags, 'offset');
  const txHz = offset === undefined ? rxHz : rxHz + Math.round(offset * 1_000_000);
  checkBand(rxHz);
  checkBand(txHz);
  return {
    rxHz,
    txHz,
    txTone: parseTone(stringFlag(flags, 'tone') ?? 'none'),
    rxTone: parseTone(stringFlag(flags, 'rx-tone') ?? 'none'),
    wide: !flags.get('narrow'),
    lowPower: Boolean(flags.get('low-power')),
    name: stringFlag(flags, 'name'),
  };
}

function channelText(c: ChannelResult): string {
  if ('empty' in c) return `ch ${c.channel}: empty`;
  return `ch ${c.channel}: rx ${c.rxMhz} tx ${c.txMhz ?? 'off'} tone ${c.txTone} rx-tone ${c.rxTone} ${c.bandwidth} ${c.power} ${c.name}`;
}

function statusText(s: RadioStatus): string {
  return [
    `firmware   ${s.firmware}`,
    `workmode   ${s.workmode}`,
    `channel A  ${s.channelA}`,
    `channel B  ${s.channelB}`,
    channelText(s),
    `note       ${s.note}`,
  ].join('\n');
}

async function statusVerb(args: ParsedArgs): Promise<number> {
  checkFlags('status', args.flags, COMMON);
  const status = await withTransport(args.flags, (t) => readStatus(new Session(t)));
  print(args, status, () => statusText(status));
  return EXIT.ok;
}

async function tuneVerb(args: ParsedArgs): Promise<number> {
  checkFlags('tune', args.flags, [...COMMON, ...TUNE_FLAGS]);
  const freq = args.positionals[0];
  if (!freq) throw new UsageError('tune needs a frequency in MHz, as in: tune 154.680 --channel 5');
  if (!args.flags.has('channel')) throw new UsageError('tune needs --channel N: read the channel number off the radio display, as in: tune 154.680 --channel 5');
  const n = numberFlag(args.flags, 'channel')!;
  checkChannelNumber(n);
  const spec = channelSpec(freq, args.flags);
  const written = await withTransport(args.flags, (t) => tune(t, n, spec));
  const result = { ...channelPayload(n, written), appliesAfterSeconds: APPLIES_AFTER_SECONDS };
  print(args, result, () => `${channelText(result)}\nwritten; the radio applies it about ${APPLIES_AFTER_SECONDS} s after this command ends`);
  return EXIT.ok;
}

async function readVerb(args: ParsedArgs): Promise<number> {
  checkFlags('read', args.flags, COMMON);
  const numText = args.positionals[0];
  if (numText === undefined) throw new UsageError('read needs a channel number 0..127, as in: read 5');
  const n = parseDecimal(numText, 'channel');
  checkChannelNumber(n);
  const ch = await withTransport(args.flags, async (t) => {
    const s = new Session(t);
    await s.start();
    return readChannel(s, n);
  });
  const result = channelPayload(n, ch);
  print(args, result, () => channelText(result));
  return EXIT.ok;
}

async function keyVerb(args: ParsedArgs): Promise<number> {
  checkFlags('key', args.flags, [...COMMON, 'seconds']);
  if (!args.flags.has('seconds')) throw new UsageError(`key needs --seconds S (max ${MAX_KEY_SECONDS}), as in: key --seconds 2`);
  const seconds = numberFlag(args.flags, 'seconds')!;
  if (seconds <= 0 || seconds > MAX_KEY_SECONDS) throw new UsageError(`--seconds takes 0 < S <= ${MAX_KEY_SECONDS}; got ${seconds}`);
  const held = await withTransport(args.flags, (t) => holdPtt(t, seconds));
  const signal = held.interrupted;
  if (signal) {
    print(args, { keyed: true, seconds: held.seconds, interrupted: signal, released: true }, () => `keyed for ${held.seconds} s; interrupted by ${signal}; PTT released`);
    return signalExitCode(signal);
  }
  print(args, { keyed: true, seconds }, () => `keyed for ${seconds} s`);
  return EXIT.ok;
}

/** Name a dump file from the local time, as in uv5r-2026-10-12T14-03-09.img. */
function defaultDumpName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `uv5r-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.img`;
}

async function dumpVerb(args: ParsedArgs): Promise<number> {
  checkFlags('dump', args.flags, [...COMMON, 'out']);
  const out = stringFlag(args.flags, 'out') ?? defaultDumpName();
  const json = wantsJson(args.flags);
  const result = await withTransport(args.flags, async (t) => {
    const s = new Session(t);
    const id = await s.start();
    const image = await dumpImage(s, (addr) => {
      if (!json && addr % 0x400 === 0) process.stderr.write(`read 0x${addr.toString(16).padStart(4, '0')}\n`);
    });
    try {
      writeFileSync(out, image);
    } catch (err) {
      throw new UsageError(`cannot write ${out}: ${(err as NodeJS.ErrnoException).message}`, { out });
    }
    return { out, bytes: image.length, firmware: id.firmware };
  });
  print(args, result, () => `wrote ${result.bytes} bytes to ${result.out} (${result.firmware})`);
  return EXIT.ok;
}

async function restoreVerb(args: ParsedArgs): Promise<number> {
  checkFlags('restore', args.flags, [...COMMON, 'force']);
  const file = args.positionals[0];
  if (!file) throw new UsageError('restore needs an image file');
  if (!args.flags.get('force')) throw new UsageError('restore rewrites channels and settings; pass --force to confirm');
  let image: Uint8Array;
  try {
    image = new Uint8Array(readFileSync(file));
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).message}`, { file });
  }
  const json = wantsJson(args.flags);
  const result = await withTransport(args.flags, async (t) => {
    const s = new Session(t);
    await s.start();
    const blocks = await restoreImage(s, image, (addr) => {
      if (!json && addr % 0x400 === 0) process.stderr.write(`write 0x${addr.toString(16).padStart(4, '0')}\n`);
    });
    return { file, blocks, appliesAfterSeconds: APPLIES_AFTER_SECONDS };
  });
  print(args, result, () => `wrote ${result.blocks} blocks from ${result.file}; applies about ${APPLIES_AFTER_SECONDS} s after this command ends`);
  return EXIT.ok;
}

async function main(args: ParsedArgs): Promise<number> {
  if (!args.verb || args.verb === 'help' || args.flags.get('help')) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.ok;
  }
  const verb = Object.hasOwn(verbs, args.verb) ? verbs[args.verb] : undefined;
  if (!verb) throw new UsageError(`unknown verb ${JSON.stringify(args.verb)}\n${helpText()}`);
  return verb.run(args);
}

let parsedFlags = new Map<string, string | true>();

/** Parse argv inside the promise chain so a UsageError from parsing reaches the error handler. */
async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, BOOLEAN_FLAGS);
  parsedFlags = args.flags;
  return main(args);
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const kind = errorKind(err);
    const body = err instanceof BaofengError ? err.toJSON() : { kind, message: err instanceof Error ? err.message : String(err) };
    if (wantsJson(parsedFlags)) process.stderr.write(`${JSON.stringify(body)}\n`);
    else process.stderr.write(`baofeng: ${body.message}\n`);
    process.exit(exitCodeFor(kind));
  },
);
