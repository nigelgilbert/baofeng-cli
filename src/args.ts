import { UsageError } from './errors.ts';

export interface ParsedArgs {
  verb: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Split argv into a verb, positionals and `--flag [value]` pairs. */
export function parseArgs(argv: string[], booleanFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const name = arg.slice(2, eq);
      if (booleanFlags.has(name)) throw new UsageError(`--${name} takes no value`);
      flags.set(name, arg.slice(eq + 1));
    } else if (booleanFlags.has(arg.slice(2))) {
      flags.set(arg.slice(2), true);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), true);
      else {
        flags.set(arg.slice(2), next);
        i++;
      }
    }
  }
  const [verb, ...rest] = positionals;
  return { verb, positionals: rest, flags };
}

export function checkFlags(verb: string, flags: Map<string, string | true>, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new UsageError(`baofeng ${verb}: unknown option --${name}`);
  }
}

export function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
}

export function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  return parseDecimal(raw, `--${name}`);
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a plain decimal with an optional sign and exponent, and throw UsageError naming `what` on anything else. */
export function parseDecimal(text: string, what: string): number {
  const trimmed = text.trim();
  const n = DECIMAL.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(n)) throw new UsageError(`${what} needs a number; got ${JSON.stringify(text)}`);
  return n;
}
