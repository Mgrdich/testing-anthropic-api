/**
 * Process-global debug-trace provider. The enabled check lives inside each
 * method, so call sites trace unconditionally instead of wrapping every call
 * in `if (debug)` guards. Off by default; the CLIs call `enable()` once when
 * `--debug` is parsed, so library code stays silent for programmatic callers.
 *
 * Same lazy-singleton shape as `Embedder.get()`.
 *
 * Expensive trace bodies (large joins, tokenization) should be passed as
 * thunks — they are only evaluated when debug is enabled.
 */

type Lazy<T> = T | (() => T);

function force<T>(v: Lazy<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

const SEPARATOR = `${"-".repeat(60)}\n`;

export class Debug {
  private static instance: Debug | null = null;

  static get(): Debug {
    if (!Debug.instance) Debug.instance = new Debug();
    
    return Debug.instance;
  }

  private on = false;

  /**
   * Readable for the rare site where debug changes behavior rather than
   * emitting a trace (e.g. showing full tool results instead of previews).
   */
  get enabled(): boolean {
    return this.on;
  }

  enable(): void {
    this.on = true;
  }

  /** One-line `[debug] …` trace. */
  log(msg: Lazy<string>): void {
    if (!this.on) return;
    process.stderr.write(`[debug] ${force(msg)}\n`);
  }

  /** Framed multi-line text block: `[debug] label:` … `[debug] /label`. */
  block(label: string, body: Lazy<string>): void {
    if (!this.on) return;
    process.stderr.write(
      `[debug] ${label}:\n${force(body)}\n[debug] /${label}\n`,
    );
  }

  /** Separator-framed pretty-printed JSON payload. */
  json(label: string, payload: Lazy<unknown>): void {
    if (!this.on) return;
    process.stderr.write(`\n${SEPARATOR}`);
    process.stderr.write(
      `[debug] ${label} ${JSON.stringify(force(payload), null, 2)}\n`,
    );
    process.stderr.write(SEPARATOR);
  }
}
