import { errMsg, makeCli, parseArgs } from "@/core/index.ts";
import {
  CheckTemplateSchema,
  combineGrader,
  createPromptScaffold,
  generateDataset,
  gradeWithCode,
  gradeWithModel,
  runPromptOnDataset,
} from "@/eval/index.ts";

const USAGE = `Usage: bun run eval <subcommand> [args]

Subcommands:
  scaffold <name> [--check json|zod|regex|none]
      Create evals/prompts/<name>/ with template files.
      Default --check: none (no code-eval.ts).

  gen <name> [--count N] [--force]
      Generate evals/datasets/<name>.jsonl using Haiku.
      Default --count: 10. --force overwrites existing dataset.

  run <name> <version> [--model id] [--force]
      Run the prompt against the dataset; write v<N>.runs.jsonl.
      Default --model: project DEFAULT_MODEL.
      Cached if v<N>.runs.jsonl exists; --force overwrites.

  code <name> <version> [--force]
      Apply evals/prompts/<name>/code-eval.ts to v<N>.runs.jsonl;
      write v<N>.code.jsonl. Skips if code-eval.ts is absent.
      Cached if v<N>.code.jsonl exists; --force overwrites.

  grade <name> <version> [--model id] [--force]
      Run model-judge on v<N>.runs.jsonl; write v<N>.graded.jsonl.
      Default --model: project DEFAULT_MODEL.
      Cached if v<N>.graded.jsonl exists; --force overwrites.

  combined <name> <version> [--weights c,m] [--markdown] [--auto] [--force]
      Join v<N>.code.jsonl (if present) + v<N>.graded.jsonl; write
      v<N>.combined.jsonl with a per-row combined score on the 1-5
      scale (code remapped via 1 + 4*code). Requires at least one of
      code or graded.
      Default --weights: 0.5,0.5 (code,model).
      --markdown also writes v<N>.combined.md (summary only).
      --auto runs any missing upstream artifacts first (run, code if
      code-eval.ts exists, grade if judge.txt exists).
      Cached if v<N>.combined.jsonl is newer than its inputs (runs,
      code, graded); --force recomputes regardless.
`;

function die(msg: string, code = 2): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(code);
}

const { getString, getInt } = makeCli(USAGE);

async function main(argv: readonly string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  const { positional, flags } = parseArgs(argv.slice(1));

  switch (sub) {
    case "scaffold": {
      const name = positional[0];
      if (!name) die("scaffold requires <name>");
      const checkRaw = getString(flags, "check") ?? "none";
      const parsedCheck = CheckTemplateSchema.safeParse(checkRaw);
      if (!parsedCheck.success) {
        die(`--check must be one of json|zod|regex|none (got ${checkRaw})`);
      }
      const { wrote, skipped } = createPromptScaffold(name, {
        check: parsedCheck.data,
      });
      for (const f of wrote) process.stdout.write(`wrote   ${f}\n`);
      for (const f of skipped) process.stdout.write(`exists  ${f}\n`);
      return;
    }
    case "gen": {
      const name = positional[0];
      if (!name) die("gen requires <name>");
      const count = getInt(flags, "count", 10, { min: 1 });
      const force = flags["force"] === true;
      const result = await generateDataset({ name, count, force });
      process.stdout.write(`wrote ${result.path} (${result.count} items)\n`);
      return;
    }
    case "run": {
      const name = positional[0];
      const version = positional[1];
      if (!name || !version) die("run requires <name> <version>");
      const model = getString(flags, "model");
      const force = flags["force"] === true;
      const result = await runPromptOnDataset({ name, version, model, force });
      const verb = result.cached ? "cached" : "wrote";
      process.stdout.write(`${verb} ${result.path} (${result.count} rows)\n`);
      return;
    }
    case "code": {
      const name = positional[0];
      const version = positional[1];
      if (!name || !version) die("code requires <name> <version>");
      const force = flags["force"] === true;
      const result = await gradeWithCode({ name, version, force });
      if (result === null) return;
      const verb = result.cached ? "cached" : "wrote";
      process.stdout.write(
        `${verb} ${result.path} (${result.count} rows)\n${result.summary}\n`,
      );
      return;
    }
    case "grade": {
      const name = positional[0];
      const version = positional[1];
      if (!name || !version) die("grade requires <name> <version>");
      const model = getString(flags, "model");
      const force = flags["force"] === true;
      const result = await gradeWithModel({ name, version, model, force });
      const verb = result.cached ? "cached" : "wrote";
      process.stdout.write(
        `${verb} ${result.path} (${result.count} rows)\n${result.summary}\n`,
      );
      return;
    }
    case "combined": {
      const name = positional[0];
      const version = positional[1];
      if (!name || !version) die("combined requires <name> <version>");
      const weightsRaw = getString(flags, "weights");
      let weights: { code: number; model: number } | undefined;
      if (weightsRaw !== undefined) {
        const parts = weightsRaw
          .split(",")
          .map((s) => Number.parseFloat(s.trim()));
        const c = parts[0];
        const m = parts[1];
        if (
          parts.length !== 2 ||
          c === undefined ||
          m === undefined ||
          !Number.isFinite(c) ||
          !Number.isFinite(m)
        ) {
          die(`--weights must be two comma-separated numbers (got ${weightsRaw})`);
        }
        if (Math.abs(c + m - 1) > 1e-9) {
          die(`--weights must sum to 1 (got ${c} + ${m} = ${c + m})`);
        }
        weights = { code: c, model: m };
      }
      const markdown = flags["markdown"] === true;
      const auto = flags["auto"] === true;
      const force = flags["force"] === true;
      const result = await combineGrader({ name, version, weights, markdown, auto, force });
      const verb = result.cached ? "cached" : "wrote";
      process.stdout.write(
        `${verb} ${result.path} (${result.count} rows)\n${result.summary}\n`,
      );
      if (result.mdPath) {
        process.stdout.write(`${verb} ${result.mdPath}\n`);
      }
      return;
    }
    default:
      die(`unknown subcommand: ${sub}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`error: ${errMsg(err)}\n`);
  process.exit(1);
});
