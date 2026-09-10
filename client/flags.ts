/**
 * A small argument parser and ANSI helpers.
 *
 * The client has no runtime dependency on purpose: it must run from a single
 * compiled binary, from a checkout, or straight from a URL, with no import map
 * and no package manager.
 */

export interface FlagSpec {
  /** Flags that take a value. */
  string?: readonly string[];
  /** Flags that are true when present. */
  boolean?: readonly string[];
  /** Flags that may appear more than once. Their value is an array. */
  collect?: readonly string[];
  /** Short name to long name, for example `{ h: "help" }`. */
  alias?: Readonly<Record<string, string>>;
}

export interface Flags {
  /** Positional arguments, in order. */
  _: string[];
  [name: string]: string | boolean | string[] | undefined;
}

/**
 * Parses `--name value`, `--name=value`, `-n value`, `--flag` and positionals.
 * `--` stops the parsing: everything after it is positional.
 */
export function parseFlags(args: readonly string[], spec: FlagSpec = {}): Flags {
  const takesValue = new Set([...(spec.string ?? []), ...(spec.collect ?? [])]);
  const collects = new Set(spec.collect ?? []);
  const alias = spec.alias ?? {};
  const out: Flags = { _: [] };
  for (const name of spec.boolean ?? []) out[name] = false;

  const long = (name: string) => alias[name] ?? name;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out._.push(arg);
      continue;
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = long(eq === -1 ? body : body.slice(0, eq));
    let value: string | undefined = eq === -1 ? undefined : body.slice(eq + 1);

    if (takesValue.has(name)) {
      if (value === undefined) {
        value = args[++i];
        if (value === undefined) throw new Error(`--${name} needs a value`);
      }
      if (collects.has(name)) {
        const list = (out[name] as string[] | undefined) ?? [];
        list.push(value);
        out[name] = list;
      } else {
        out[name] = value;
      }
    } else {
      out[name] = value === undefined ? true : value !== "false";
    }
  }
  return out;
}

/* ------------------------------------------------------------- colours ---- */

function wanted(): boolean {
  try {
    if (Deno.env.get("NO_COLOR")) return false;
    return Deno.stdout.isTerminal();
  } catch {
    return false; // no --allow-env, so stay plain
  }
}

const on = wanted();
const wrap = (code: number) => (s: string) => on ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold: (s: string) => string = wrap(1);
export const dim: (s: string) => string = wrap(2);
export const red: (s: string) => string = wrap(31);
export const green: (s: string) => string = wrap(32);
export const yellow: (s: string) => string = wrap(33);
