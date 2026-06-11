import { Debug, makeCli, parseArgs, runMain } from "@/core/index.ts";
import type { DieFn, Flags } from "@/core/index.ts";
import { generateSyntheticDoc } from "@/rag/doc/generate.ts";
import { runRag } from "@/rag/rag.ts";
import type { ChunkerConfig, Retrieved } from "@/rag/types.ts";

const USAGE = `Usage: bun run rag <subcommand> [args]

Subcommands:
  generate-doc [--out PATH] [--sections N] [--model ID] [--force]
      Generate a synthetic engineering handbook by calling the Anthropic API
      once per H1 section. Writes incrementally to disk.
      Defaults: --out ./rag-handbook.md, --sections 12,
                --model claude-haiku-4-5-20251001

  query <doc-path> "question" [flags]
      Chunk the doc, build retrieval indices, retrieve top-k chunks, and
      (by default) generate an answer with Claude.

      --chunker size|structure|semantic   default: structure
      --k N                               default: 5
      --retrieval vector|bm25|hybrid      default: hybrid
      --no-generate                       skip the Claude answer step
      --show-chunks                       print the full text of each chunk
      --answer-model ID                   model id for the answer step
      --debug                             emit [debug] traces to stderr:
                                            full chunk inventory, query
                                            tokens, per-retriever rankings
                                            before RRF, exact prompt

      Size chunker:
        --size-max-chars N        default 1000
        --size-overlap N          default 150
        --size-split-on paragraph|sentence|char  default paragraph

      Structure chunker:
        --structure-max-level 1|2|3   default 3
        --structure-max-chars N       default 2000
        --structure-join-short bool   default true

      Semantic chunker:
        --semantic-window N           default 1
        --semantic-percentile N       default 95
        --semantic-min-chars N        default 200
        --semantic-max-chars N        default 2000

  compare <doc-path> "question" [--k N] [--retrieval MODE] [--generate] [--debug]
      Run all three chunkers with their defaults on the same query and print
      a side-by-side comparison of chunk counts, timings, and top-k chunks.
      --generate is off by default to keep the comparison cheap.
      --debug emits per-stage traces to stderr for each chunker run.
`;

const cli = makeCli(USAGE);
const die: DieFn = cli.die;
const { getString, getInt, getFloat, getBool, getEnum } = cli;

const CHUNKERS = ["size", "structure", "semantic"] as const;
const RETRIEVALS = ["vector", "bm25", "hybrid"] as const;
const SIZE_SPLIT = ["paragraph", "sentence", "char"] as const;

function buildChunkerConfig(
  strategy: ChunkerConfig["strategy"],
  flags: Flags["flags"],
): ChunkerConfig {
  if (strategy === "size") {
    return {
      strategy: "size",
      maxChars: getInt(flags, "size-max-chars", 1000, { min: 1 }),
      overlapChars: getInt(flags, "size-overlap", 150, { min: 0 }),
      splitOn: getEnum(flags, "size-split-on", SIZE_SPLIT, "paragraph"),
    };
  }
  if (strategy === "structure") {
    return {
      strategy: "structure",
      maxLevel: getInt(flags, "structure-max-level", 3, { min: 1, max: 3 }),
      maxChars: getInt(flags, "structure-max-chars", 2000, { min: 1 }),
      joinShortSiblings: getBool(flags, "structure-join-short", true),
    };
  }
  return {
    strategy: "semantic",
    sentenceWindow: getInt(flags, "semantic-window", 1, { min: 0 }),
    breakpointPercentile: getFloat(flags, "semantic-percentile", 95, { min: 0, max: 100 }),
    minChunkChars: getInt(flags, "semantic-min-chars", 200, { min: 1 }),
    maxChunkChars: getInt(flags, "semantic-max-chars", 2000, { min: 1 }),
  };
}

function printRetrieved(
  retrieved: ReadonlyArray<Retrieved>,
  showChunks: boolean,
) {
  for (const r of retrieved) {
    const headingPath = r.chunk.metadata.headingPath?.join(" > ") ?? "";
    process.stdout.write(
      `\n[${r.rank}] id=${r.chunk.id} score=${r.score.toFixed(3)}${
        headingPath ? ` path="${headingPath}"` : ""
      }\n`,
    );
    if (showChunks) {
      process.stdout.write(`${r.chunk.text}\n`);
    } else {
      const preview = r.chunk.text.slice(0, 200).replace(/\s+/g, " ");
      process.stdout.write(
        `  ${preview}${r.chunk.text.length > 200 ? "..." : ""}\n`,
      );
    }
  }
}

async function cmdGenerateDoc(flags: Flags["flags"]) {
  const outPath = getString(flags, "out") ?? "./rag-handbook.md";
  const sections = getInt(flags, "sections", 12, { min: 1 });
  const model = getString(flags, "model");
  const force = flags["force"] === true;

  if (await Bun.file(outPath).exists() && !force) {
    die(`${outPath} already exists (pass --force to overwrite)`);
  }

  const result = await generateSyntheticDoc({
    outPath,
    sections,
    ...(model ? { model } : {}),
    onProgress: (done, total, title) => {
      process.stderr.write(`[${done}/${total}] wrote section: ${title}\n`);
    },
  });
  process.stdout.write(
    `\nwrote ${result.outPath} (${result.sectionsWritten} sections, ${result.totalChars} chars)\n`,
  );
}

async function cmdQuery(positional: string[], flags: Flags["flags"]) {
  const docPath = positional[0];
  const question = positional.slice(1).join(" ");
  if (!docPath || !question) die("query requires <doc-path> \"question\"");

  const strategy = getEnum(flags, "chunker", CHUNKERS, "structure");
  const k = getInt(flags, "k", 5, { min: 1 });
  const retrieval = getEnum(flags, "retrieval", RETRIEVALS, "hybrid");
  const generate = flags["no-generate"] !== true;
  const showChunks = flags["show-chunks"] === true;
  const answerModel = getString(flags, "answer-model");

  const chunkerConfig = buildChunkerConfig(strategy, flags);

  const result = await runRag({
    docPath,
    query: question,
    chunkerConfig,
    k,
    retrieval,
    generate,
    ...(answerModel ? { answerModel } : {}),
    onText: (delta) => process.stdout.write(delta),
    onRetrieved: (retrieved, timings, chunks) => {
      process.stdout.write(
        `chunker=${strategy} chunks=${chunks.length} ` +
          `retrieval=${retrieval} k=${k}\n` +
          `timings: chunk=${timings.chunk.toFixed(0)}ms ` +
          `index=${timings.index.toFixed(0)}ms ` +
          `retrieve=${timings.retrieve.toFixed(0)}ms\n`,
      );
      process.stdout.write(`\n=== retrieved chunks ===`);
      printRetrieved(retrieved, showChunks);
      if (generate && retrieved.length > 0) {
        process.stdout.write(`\n=== answer ===\n`);
      }
    },
  });

  if (result.timings.generate !== undefined) {
    process.stdout.write(
      `\ngenerate=${result.timings.generate.toFixed(0)}ms\n`,
    );
  }
}

async function cmdCompare(positional: string[], flags: Flags["flags"]) {
  const docPath = positional[0];
  const question = positional.slice(1).join(" ");
  if (!docPath || !question) die("compare requires <doc-path> \"question\"");

  const k = getInt(flags, "k", 5, { min: 1 });
  const retrieval = getEnum(flags, "retrieval", RETRIEVALS, "hybrid");
  const generate = flags["generate"] === true;

  const strategies: Array<ChunkerConfig["strategy"]> = ["size", "structure", "semantic"];
  for (const strategy of strategies) {
    const chunkerConfig = buildChunkerConfig(strategy, {});
    process.stdout.write(`\n========== chunker: ${strategy} ==========\n`);
    const result = await runRag({
      docPath,
      query: question,
      chunkerConfig,
      k,
      retrieval,
      generate,
      onText: generate ? (delta) => process.stdout.write(delta) : undefined,
      onRetrieved: (retrieved, timings, chunks) => {
        process.stdout.write(
          `chunks=${chunks.length} ` +
            `timings: chunk=${timings.chunk.toFixed(0)}ms ` +
            `index=${timings.index.toFixed(0)}ms ` +
            `retrieve=${timings.retrieve.toFixed(0)}ms\n`,
        );
        printRetrieved(retrieved, false);
        if (generate && retrieved.length > 0) {
          process.stdout.write(`\n=== answer ===\n`);
        }
      },
    });
    if (result.timings.generate !== undefined) {
      process.stdout.write(
        `\ngenerate=${result.timings.generate.toFixed(0)}ms\n`,
      );
    }
  }
}

async function main(argv: readonly string[]) {
  const sub = argv[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const { positional, flags } = parseArgs(argv.slice(1));
  if (flags["debug"] === true) Debug.get().enable();

  switch (sub) {
    case "generate-doc":
      return cmdGenerateDoc(flags);
    case "query":
      return cmdQuery(positional, flags);
    case "compare":
      return cmdCompare(positional, flags);
    default:
      die(`unknown subcommand: ${sub}`);
  }
}

runMain(main);
