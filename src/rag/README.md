# src/rag/

A self-contained RAG (Retrieval-Augmented Generation) playground for
experimenting with chunking strategies, retrieval backends, and hybrid
fusion. CLI entry is `src/rag/cli.ts`, exposed as `bun run rag`.

It is deliberately decoupled from the main CLI and the tool-use loop: this
module exists so you can iterate on RAG primitives in isolation, swap in new
chunkers or retrievers, and measure their behavior.

## Try it out (sequential walkthrough)

Run these in order. Each step exercises a different part of the system.
Steps 1-5 don't spend any API tokens; steps 6-7 call Claude.

### 0. One-time setup

```bash
bun install
bun run typecheck      # the only correctness gate
```

You also need `ANTHROPIC_API_KEY` set (in `.env` or your shell) — but only
for the generation steps below.

### 1. Cheapest path: BM25 + structure, no API (~50ms)

Point at any Markdown file. BM25 doesn't load the embedder; `--no-generate`
skips the Claude call. This validates the chunker, BM25 index, and the
retrieval pipeline end-to-end.

```bash
bun run rag query path/to/any.md "your question" \
  --chunker structure --retrieval bm25 --no-generate --k 3
```

If you don't have a Markdown file handy, drop a few paragraphs into
`/tmp/test.md` and use that.

### 2. Exercise the embedder: vector retrieval, no API (~1-5s first run)

This loads `Xenova/all-MiniLM-L6-v2` on first call (downloads ~25MB to
`~/.cache/huggingface`); subsequent runs use the cache.

```bash
bun run rag query path/to/any.md "your question" \
  --chunker structure --retrieval vector --no-generate --k 3
```

Watch stderr for `[embedder] loading Xenova/all-MiniLM-L6-v2`.

### 3. Exercise the semantic chunker, no API

The semantic chunker calls the embedder during chunking (sentence-window
cosine distances + 95th percentile breakpoints), then BM25+vector retrieve.

```bash
bun run rag query path/to/any.md "your question" \
  --chunker semantic --retrieval hybrid --no-generate --k 3
```

### 4. Try every chunker on the same query (no API)

```bash
bun run rag compare path/to/any.md "your question" --k 3
```

Output is sectioned by chunker — eyeball whether each one surfaces the same
relevant content or different chunks.

### 5. Tune chunker params

```bash
# tighter size chunks with more overlap
bun run rag query path/to/any.md "your question" \
  --chunker size --size-max-chars 500 --size-overlap 200 \
  --no-generate --k 3

# semantic with a more aggressive breakpoint (more, smaller chunks)
bun run rag query path/to/any.md "your question" \
  --chunker semantic --semantic-percentile 75 \
  --no-generate --k 3
```

### 6. Generate the synthetic handbook (~12 Haiku calls, ~$0.05)

If you don't have a corpus handy, generate the example. Start with `--sections 2`
to keep it cheap; bump to 12 for the full ~18-20k word handbook.

```bash
bun run rag generate-doc --sections 2 --out ./rag-handbook.md
# re-run safely:
bun run rag generate-doc --sections 12 --out ./rag-handbook.md --force
```

Watch stderr for `[N/M] wrote section: <title>` after each call.

### 7. Full pipeline: retrieve + generate an answer (1 Sonnet call)

```bash
bun run rag query ./rag-handbook.md "How do we handle postmortems?" --k 5
```

The retrieved chunks print first, then Claude's streaming answer with
inline `[N]` citations.

## End-to-end pipeline

```
                    ┌──────────────────┐
                    │   Markdown doc   │
                    └────────┬─────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │  Chunker (one of)   │
                  │  ─────────────────  │
                  │  size               │
                  │  structure          │
                  │  semantic           │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │      Chunk[]        │
                  │  { id, text, meta } │
                  └─────────┬───────────┘
                            │
              ┌─────────────┴──────────────┐
              │                            │
              ▼                            ▼
   ┌──────────────────┐         ┌────────────────────┐
   │  BM25Retriever   │         │  VectorRetriever   │
   │  (lexical)       │         │  (semantic)        │
   │  tokenize+IDF    │         │  MiniLM embeddings │
   └────────┬─────────┘         └─────────┬──────────┘
            │                             │
            │       ┌─────────────┐       │
            └──────►│ user query  │◄──────┘
                    └──────┬──────┘
                           │ .search(query, k*3)
                           ▼
                  ┌──────────────────┐
                  │ Reciprocal Rank  │
                  │ Fusion (RRF)     │
                  │ k=60             │
                  └────────┬─────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ Top-k Retrieved  │
                  │ chunks           │
                  └────────┬─────────┘
                           │  (optional)
                           ▼
                  ┌──────────────────┐
                  │ streamAssistant  │
                  │ Message (Claude) │
                  │ cites [N] inline │
                  └──────────────────┘
```

## Module layout

```
src/rag/
├── cli.ts              # `bun run rag <subcommand>` dispatcher
├── index.ts            # public barrel — re-exports API + types
├── types.ts            # Zod schemas + Retriever interface
├── rag.ts              # runRag() orchestrator
├── embedder.ts         # Embedder singleton (lazy MiniLM)
├── vector-store.ts     # VectorStore + VectorRetriever
├── bm25.ts             # BM25Index + BM25Retriever
├── hybrid.ts           # rrf() + retrieveHybrid()
├── generate-answer.ts  # buildContext() + answerWithClaude()
├── chunkers/
│   ├── index.ts        # chunk() dispatcher
│   ├── size.ts
│   ├── structure.ts
│   └── semantic.ts
└── doc/
    ├── template.ts     # TOPICS: handbook section seeds
    └── generate.ts     # generateSyntheticDoc() — Anthropic API per section
```

## Chunkers

All three return `Chunk[]` shaped as
`{ id, text, metadata: { strategy, startChar, endChar, headingPath? } }`. The
dispatcher in `chunkers/index.ts` picks one based on `ChunkerConfig.strategy`.

```
input doc:
┌─────────────────────────────────────┐
│ # Database Migrations               │
│ intro paragraph                     │
│ ## Online Schema Changes            │
│ paragraph 1                         │
│ ```sql ALTER TABLE ... ```          │
│ paragraph 2                         │
│ ## Backfills                        │
│ paragraph 3                         │
└─────────────────────────────────────┘

size chunker (maxChars=1000, overlap=150):
┌──────────────────────┐
│ chars 0..1000        │──┐
│ (boundary-snapped)   │  │ overlap
└──────────────────────┘  │
                          ▼
                  ┌──────────────────────┐
                  │ chars 850..1850      │
                  └──────────────────────┘
- Pure character window. Cheap. Ignores structure entirely.
- Knobs: --size-max-chars, --size-overlap, --size-split-on

structure chunker (maxLevel=3, joinShortSiblings):
┌───────────────────────────────┐  ┌─────────────────────┐
│ path: [Database Migrations,   │  │ path: [Database     │
│        Online Schema Changes] │  │  Migrations,        │
│ text:  paragraph 1            │  │  Backfills]         │
│        ```sql ...```          │  │ text: paragraph 3   │
│        paragraph 2            │  │                     │
└───────────────────────────────┘  └─────────────────────┘
- Splits on Markdown headings, keeps `headingPath` in metadata.
- Code fences are atomic (never split mid-fence).
- Falls back to size chunker if NO headings are detected.
- Knobs: --structure-max-level (1-3), --structure-max-chars,
         --structure-join-short

semantic chunker (sentenceWindow=1, percentile=95):

   sentences:  [s0  s1  s2  s3  s4  s5  s6]
                 \   |   |   |   |   |   /
                  \  |   |   |   |   |  /     trigram groups
                   \ |   |   |   |   | /      [s_i-1, s_i, s_i+1]
                    v v   v   v   v   v
   embed each:   [g0  g1  g2  g3  g4  g5]
                  │   │   │   │   │   │
                  └───┴───┴───┴───┴───┘
                       dist[i] = 1 - cos(g_i, g_i+1)

   dist:        ┌─┐     ┌──────────┐
                │ │     │  spike!  │
            ────┘ └─────┘          └──── ◄─── 95th percentile threshold
                  │                 │
            sentence groups          break point

   chunks:      [s0 s1 s2 s3]  ┊  [s4 s5 s6]
                                 ▲
                                 break where cosine distance >= threshold

- Sentence-window cosine distance with percentile breakpoints.
- Deterministic given fixed model weights; auto-scales via percentile.
- Knobs: --semantic-window, --semantic-percentile,
         --semantic-min-chars, --semantic-max-chars
```

## Retrievers

Every retrieval backend implements the same interface, so the orchestrator
and hybrid fusion stay backend-agnostic.

```
              ┌────────────────────────────────────┐
              │       interface Retriever          │
              │  ───────────────────────────────   │
              │  readonly name: string             │
              │  readonly size: number             │
              │  add(id, text)        → Promise    │
              │  addBatch(items)      → Promise    │
              │  search(query, k)     → ScoredId[] │
              └─────────────────┬──────────────────┘
                                │ implements
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
       ┌──────────────────┐           ┌────────────────────┐
       │  BM25Retriever   │           │  VectorRetriever   │
       │  ──────────────  │           │  ────────────────  │
       │  tokenize text   │           │  Embedder (MiniLM) │
       │  inverted index  │           │  VectorStore       │
       │  BM25+ scoring   │           │  cosine via dot    │
       │  (k1=1.5, b=.75) │           │  (pre-normalized)  │
       └──────────────────┘           └────────────────────┘
```

`BM25Retriever` and `VectorRetriever` are thin wrappers around the
lower-level `BM25Index` and `VectorStore` classes. You can still use those
directly if you want raw access (e.g., for ad-hoc cosine queries with an
externally-computed vector).

### Adding a new retriever

The interface is the only contract. A reranker, TF-IDF index, or
cross-encoder is just another class that implements `Retriever`:

```ts
import type { Retriever, ScoredId } from "@/rag/types.ts";

export class TfidfRetriever implements Retriever {
  readonly name = "tfidf";
  // ...
  async add(id: string, text: string): Promise<void> { /* ... */ }
  async addBatch(items: ReadonlyArray<{ id: string; text: string }>): Promise<void> { /* ... */ }
  async search(query: string, k: number): Promise<ScoredId[]> { /* ... */ }
  get size(): number { /* ... */ return 0; }
}
```

Pass it into `retrieveHybrid([new TfidfRetriever(), new BM25Retriever(), ...], query, k)`
— RRF fuses any number of rankings without code changes.

## Reciprocal Rank Fusion (RRF)

RRF combines rankings from multiple retrievers by summing rank-based scores.
Scores from individual retrievers are ignored — only ranks matter — which is
why RRF can combine BM25 (unbounded BM25+ scores) and vector cosine
(`[0, 1]`) without normalization.

```
BM25 ranking:           Vector ranking:
  rank 1: chunk-X         rank 1: chunk-A
  rank 2: chunk-Y         rank 2: chunk-X
  rank 3: chunk-A         rank 3: chunk-Z
  rank 4: chunk-Z         rank 4: chunk-Y

For each id, sum  1 / (k + rank)   with k=60 (default):

  chunk-X: 1/(60+1) + 1/(60+2) = 0.01639 + 0.01613 = 0.03252
  chunk-A: 1/(60+3) + 1/(60+1) = 0.01587 + 0.01639 = 0.03226
  chunk-Y: 1/(60+2) + 1/(60+4) = 0.01613 + 0.01563 = 0.03176
  chunk-Z: 1/(60+4) + 1/(60+3) = 0.01563 + 0.01587 = 0.03150

Sort descending → final ranking:
  [chunk-X, chunk-A, chunk-Y, chunk-Z]
```

The `k` constant (default 60, configurable via `rrfK`) dampens the
contribution of low-ranked items. A larger `k` makes the fusion more
egalitarian; a smaller `k` privileges top hits.

## Generation step

When `--no-generate` is not passed, the retrieved chunks are formatted as
numbered context blocks and sent to Claude via the existing
`streamAssistantMessage` from `@/core/messages.ts`:

```
System: "You answer using ONLY the provided context. Cite chunk numbers
        inline like [1] or [3]. If the context is insufficient, say so
        explicitly — do not invent facts."

User:   "Context:
         [1] (id=struct-database-migrations.online-schema-change-0, score=0.553)
         <chunk 1 text>
         ---
         [2] (id=struct-database-migrations.backfills-1, score=0.270)
         <chunk 2 text>
         ---
         ...
         Question: How do I do an online schema change?"
```

The streamed response is written to stdout as it arrives. Default model is
the project's `DEFAULT_MODEL` (`claude-sonnet-4-6`); override with
`--answer-model <id>`.

## CLI reference

### `generate-doc [--out PATH] [--sections N] [--model ID] [--force]`

Generates a synthetic engineering handbook by calling the Anthropic API
once per H1 section. Writes the file incrementally so a crash mid-run
preserves whatever was already written.

| Flag         | Default                       | Effect                              |
|--------------|-------------------------------|-------------------------------------|
| `--out`      | `./rag-handbook.md`           | Output path                         |
| `--sections` | `12` (capped at `TOPICS.length`) | Number of H1 sections to generate |
| `--model`    | `claude-haiku-4-5-20251001`   | Anthropic model id                  |
| `--force`    | off                           | Overwrite existing `--out`          |

### `query <doc-path> "question" [flags]`

Loads the doc, runs the selected chunker, builds the retrieval index/indices,
retrieves top-k, and (by default) streams an answer from Claude.

| Flag                    | Default    | Effect                                  |
|-------------------------|------------|-----------------------------------------|
| `--chunker`             | `structure`| `size` \| `structure` \| `semantic`      |
| `--k`                   | `5`        | Top-k chunks to retrieve                |
| `--retrieval`           | `hybrid`   | `vector` \| `bm25` \| `hybrid`           |
| `--no-generate`         | off        | Skip the Claude answer step             |
| `--show-chunks`         | off        | Print full chunk text (not just preview)|
| `--answer-model`        | `DEFAULT_MODEL` | Model id for the answer step       |
| `--size-max-chars`      | `1000`     | size only                               |
| `--size-overlap`        | `150`      | size only                               |
| `--size-split-on`       | `paragraph`| size only — `paragraph`/`sentence`/`char`|
| `--structure-max-level` | `3`        | structure only (1-3)                    |
| `--structure-max-chars` | `2000`     | structure only                          |
| `--structure-join-short`| `true`     | structure only                          |
| `--semantic-window`     | `1`        | semantic only                           |
| `--semantic-percentile` | `95`       | semantic only                           |
| `--semantic-min-chars`  | `200`      | semantic only                           |
| `--semantic-max-chars`  | `2000`     | semantic only                           |

Cross-chunker flags are silently ignored by other chunkers.

### `compare <doc-path> "question" [--k N] [--retrieval MODE] [--generate]`

Runs all three chunkers with their defaults on the same query and prints
chunk counts, timings, and top-k for each. `--generate` is off by default to
keep the comparison cheap (skips Claude calls).

## Conventions

- All schemas in `types.ts` as Zod objects; types derive via `z.infer`.
- `@/*` absolute imports only, with the `.ts` extension.
- Type-only imports marked (`import type ...`) per `verbatimModuleSyntax`.
- Strict mode; `noUncheckedIndexedAccess` means index access is narrowed
  before use throughout (see the `??` guards in vector-store / bm25).
- The Anthropic client is reused via `streamAssistantMessage` /
  `addAssistantMessage` from `@/core/messages.ts` — this module never
  instantiates its own client.

## Known quirks

- **`structureChunker` `joinShortSiblings` default**: when a section's text
  is under 200 chars, it's merged into the next section, which adopts the
  later section's `headingPath`. The intro paragraph under a top-level H1
  with no own content often gets glued into the first H2 this way. Pass
  `--structure-join-short false` if you'd rather every section stand alone.
- **First embedding model load** downloads ~25MB to `~/.cache/huggingface`.
  Subsequent runs use the cache. The CLI prints a `[embedder] loading ...`
  notice on the first `ensureReady()` call per process.
- **RRF scores are tiny** (max ≈ `R / (k + 1)` for R retrievers and `k=60`,
  so ~0.033 for two retrievers). They're for ranking, not absolute quality
  — only ordering matters.
- **The semantic chunker calls the embedder during chunking**, before the
  retrieval index is built. For long docs this is the dominant cost in
  `--chunker semantic` runs.
