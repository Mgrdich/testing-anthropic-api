/**
 * Argv parsing helpers shared by subcommand-style sub-CLIs (eval, rag, …).
 *
 * The main testing-anthropic CLI in `src/cli/` uses its own strongly-typed
 * parser tailored to its specific flag set. This module is for the
 * "subcommand + flag bag" pattern: `bun run <module> <subcommand> [args]`.
 *
 * Usage:
 *   const USAGE = `Usage: ...`;
 *   const cli = makeCli(USAGE);
 *   const { positional, flags } = parseArgs(argv.slice(1));
 *   const k = cli.getInt(flags, "k", 5, { min: 1 });
 *   const mode = cli.getEnum(flags, "mode", ["a", "b", "c"], "a");
 *   runMain(main);
 */

import { errMsg } from "@/core/util.ts";

/**
 * Top-level entrypoint catch shared by every sub-CLI. Reads argv from
 * process.argv (slicing the `bun run …` prefix), runs `main`, and exits
 * 1 with `error: <msg>` on any thrown error.
 */
export function runMain(
  main: (argv: readonly string[]) => Promise<void>,
): void {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`error: ${errMsg(err)}\n`);
    process.exit(1);
  });
}

/**
 * Write a usage-block error to stderr and exit. The per-CLI `die` function
 * stays local (TS narrowing on `never` arrow functions doesn't propagate
 * through destructuring) but its body is this single call.
 */
export function writeUsageError(
  usage: string,
  msg: string,
  code = 2,
): never {
  process.stderr.write(`error: ${msg}\n\n${usage}`);
  process.exit(code);
}

export type Flags = {
  positional: string[];
  flags: Record<string, string | true>;
};

export function parseArgs(argv: readonly string[]): Flags {
  const out: Flags = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

export function getString(
  flags: Flags["flags"],
  key: string,
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export function getBoolFlag(flags: Flags["flags"], key: string): boolean {
  return flags[key] === true;
}

export type IntOpts = { min?: number; max?: number };
export type FloatOpts = { min?: number; max?: number };

/**
 * Function type for the per-CLI `die` helper. Exported so sub-CLIs can
 * destructure most of `makeCli`'s return but anchor `die` with an explicit
 * type annotation (`const die: DieFn = cli.die`), which preserves TS's
 * `never`-return narrowing through control-flow analysis. Destructured
 * bindings lose that narrowing — see the audit in commit 09aa54f's
 * follow-up discussion.
 */
export type DieFn = (msg: string, code?: number) => never;

export type Cli = {
  die: DieFn;
  getString: (flags: Flags["flags"], key: string) => string | undefined;
  getBoolFlag: (flags: Flags["flags"], key: string) => boolean;
  getInt: (
    flags: Flags["flags"],
    key: string,
    fallback: number,
    opts?: IntOpts,
  ) => number;
  getFloat: (
    flags: Flags["flags"],
    key: string,
    fallback: number,
    opts?: FloatOpts,
  ) => number;
  getBool: (flags: Flags["flags"], key: string, fallback: boolean) => boolean;
  getEnum: <T extends string>(
    flags: Flags["flags"],
    key: string,
    allowed: readonly T[],
    fallback: T,
  ) => T;
};

export function makeCli(usage: string): Cli {
  function die(msg: string, code = 2): never {
    writeUsageError(usage, msg, code);
  }

  const getInt = (
    flags: Flags["flags"],
    key: string,
    fallback: number,
    opts?: IntOpts,
  ): number => {
    const v = getString(flags, key);
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) die(`--${key} must be an integer (got ${v})`);
    if (opts?.min !== undefined && n < opts.min) {
      die(`--${key} must be >= ${opts.min} (got ${n})`);
    }
    if (opts?.max !== undefined && n > opts.max) {
      die(`--${key} must be <= ${opts.max} (got ${n})`);
    }
    return n;
  };

  const getFloat = (
    flags: Flags["flags"],
    key: string,
    fallback: number,
    opts?: FloatOpts,
  ): number => {
    const v = getString(flags, key);
    if (v === undefined) return fallback;
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) die(`--${key} must be a number (got ${v})`);
    if (opts?.min !== undefined && n < opts.min) {
      die(`--${key} must be >= ${opts.min} (got ${n})`);
    }
    if (opts?.max !== undefined && n > opts.max) {
      die(`--${key} must be <= ${opts.max} (got ${n})`);
    }
    return n;
  };

  const getBool = (
    flags: Flags["flags"],
    key: string,
    fallback: boolean,
  ): boolean => {
    const raw = flags[key];
    if (raw === undefined) return fallback;
    if (raw === true) return true;
    const v = raw.toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
    die(`--${key} must be a boolean (got ${raw})`);
  };

  const getEnum = <T extends string>(
    flags: Flags["flags"],
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const v = getString(flags, key) ?? fallback;
    if (!allowed.includes(v as T)) {
      die(`--${key} must be ${allowed.join("|")} (got ${v})`);
    }
    return v as T;
  };

  return { die, getString, getBoolFlag, getInt, getFloat, getBool, getEnum };
}
