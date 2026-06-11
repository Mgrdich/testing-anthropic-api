# src/rag/

A self-contained RAG (Retrieval-Augmented Generation) playground for
experimenting with chunking strategies, retrieval backends, and hybrid
fusion. CLI entry is `src/rag/cli.ts`, exposed as `bun run rag`.

It is deliberately decoupled from the main CLI and the tool-use loop: this
module exists so you can iterate on RAG primitives in isolation, swap in new
chunkers or retrievers, and measure their behavior.

## Try it out (sequential walkthrough)

Run these in order — every command is copy-pasteable as written and builds
on the previous step. Steps 1 and 8 are the only ones that spend API
tokens; steps 2 through 7 use `--no-generate` to skip the Claude call.

### 0. One-time setup

```bash
bun install
bun run typecheck      # the only correctness gate
```

You also need `ANTHROPIC_API_KEY` set (in `.env` or your shell) — but only
for steps 1 and 8.

### 1. Get a corpus: generate the synthetic handbook (~2 Haiku calls, <$0.01)

The repo doesn't ship a corpus (`rag-handbook.md` is gitignored), so
generate one. `--sections 2` produces the "Code Review" and "Incident
Response" chapters — enough for every step below; bump to 12 for the
full ~18-20k word handbook.

```bash
bun run rag generate-doc --sections 2 --out ./rag-handbook.md
# later, the full handbook (~12 Haiku calls, ~$0.05):
bun run rag generate-doc --sections 12 --out ./rag-handbook.md --force
```

Watch stderr for `[N/M] wrote section: <title>` after each call.

Already have a Markdown file? Use it instead — substitute your path and a
question about its content in every command below.

### 2. Cheapest path: BM25 + structure, no API (~50ms)

BM25 doesn't load the embedder; `--no-generate` skips the Claude call.
This validates the chunker, BM25 index, and the retrieval pipeline
end-to-end. The query shares exact terms with the doc — lexical
retrieval's home turf.

```bash
bun run rag query ./rag-handbook.md "What are the incident severity levels?" \
  --chunker structure --retrieval bm25 --no-generate --k 3
```

### 3. Exercise the embedder: vector retrieval, no API (~1-5s first run)

This loads `Xenova/all-MiniLM-L6-v2` on first call (downloads ~25MB to
`~/.cache/huggingface`); subsequent runs use the cache. The query is a
paraphrase that shares almost no words with the doc — embeddings should
still find the incident-response content where BM25 would struggle.

```bash
bun run rag query ./rag-handbook.md "what to do when production breaks" \
  --chunker structure --retrieval vector --no-generate --k 3
```

Watch stderr for `[embedder] loading Xenova/all-MiniLM-L6-v2`.

### 4. Exercise the semantic chunker, no API

The semantic chunker calls the embedder during chunking (sentence-window
cosine distances + 95th percentile breakpoints), then runs hybrid retrieval
(BM25 + vector with RRF fusion) on the resulting chunks.

```bash
bun run rag query ./rag-handbook.md "How should reviewers give feedback?" \
  --chunker semantic --retrieval hybrid --no-generate --k 3
```

### 5. Try every chunker on the same query (no API)

```bash
bun run rag compare ./rag-handbook.md "How are postmortems run?" --k 3
```

Output is sectioned by chunker — eyeball whether each one surfaces the same
relevant content or different chunks. Add `--debug` to also see per-stage
traces for each chunker run.

### 6. Inspect a run with `--debug` (no API)

```bash
bun run rag query ./rag-handbook.md "How are postmortems run?" \
  --no-generate --k 3 --debug 2>debug.log
```

Stdout still gets the normal chunker / timings / retrieved-chunks output;
`debug.log` will contain the full chunk inventory, the tokenized query, and
the per-retriever rankings before RRF fuses them. See [Debug mode](#debug-mode)
below for what each trace block means.

### 7. Tune chunker params

```bash
# tighter size chunks with more overlap
bun run rag query ./rag-handbook.md "How are postmortems run?" \
  --chunker size --size-max-chars 500 --size-overlap 200 \
  --no-generate --k 3

# semantic with a more aggressive breakpoint (more, smaller chunks)
bun run rag query ./rag-handbook.md "How are postmortems run?" \
  --chunker semantic --semantic-percentile 75 \
  --no-generate --k 3
```

### 8. Full pipeline: retrieve + generate an answer (1 Sonnet call)

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

The diagram depicts the default `--retrieval hybrid` path. With
`--retrieval vector` or `--retrieval bm25` only one retriever runs, the
call is `.search(query, k)` (no `*3` oversample), and the RRF stage is
skipped — the single ranking flows directly into Top-k.

**Two-phase view.** The big diagram above hides a timing distinction
that matters once you start thinking about cost and caching: the top
half is question-blind, the bottom half is per-query.

```
═══ PHASE 1 ═══ preprocessing — question-blind, once per (doc, config)

   ┌───────┐    ┌─────────┐    ┌────────┐    ┌──────────────────────┐
   │  doc  │───►│ chunker │───►│ chunks │───►│ BM25 + vector indices│
   └───────┘    └─────────┘    └────────┘    └──────────┬───────────┘
                                                        │
                                       indices live in memory / on disk
                                                        │
                                                        ▼
═══ PHASE 2 ═══ per-query — question enters here, once per question

   ┌──────────┐    ┌────────────────┐    ┌──────────────┐    ┌────────┐
   │ question │───►│ retrieve top-k │───►│ format prompt│───►│ Claude │
   └──────────┘    └────────────────┘    └──────────────┘    └────────┘
```

Phase 1 is a pure function of `(doc, chunker config)`; the question
doesn't exist yet. Phase 2 starts the moment the retriever's `.search()`
is called with the query string. In this codebase phase 1 re-runs on
every `bun run rag query` invocation — no persistent index store. In
a production system you'd cache the phase-1 outputs and only redo them
when the source doc changes; only phase 2 scales with query rate.

## Module layout

```
src/rag/
├── cli.ts              # `bun run rag <subcommand>` dispatcher
├── index.ts            # public barrel — re-exports API + types
├── types.ts            # Zod schemas + Retriever interface
├── rag.ts              # runRag() orchestrator
├── embedder.ts         # Embedder singleton (lazy MiniLM)
├── math.ts             # dot() + l2Normalize() — shared Float32Array helpers
├── vector-store.ts     # VectorStore + VectorRetriever
├── bm25.ts             # BM25Index + BM25Retriever + tokenize()
├── hybrid.ts           # rrf() + retrieveHybrid() + HybridRanking type
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

### Semantic chunker, beyond the diagram

The ASCII diagram above shows the percentile-breakpoint idea. Two things
it glosses over, and a couple of caveats worth knowing before you reach
for `--chunker semantic`.

**Size-cleanup pass** (`mergeAndSplit` in `chunkers/semantic.ts`) runs
after the breakpoints are chosen and overrides them where needed:

- Segments shorter than `minChunkChars` (default 200) get **merged
  forward** into the next segment.
- Segments longer than `maxChunkChars` (default 2000) get **sub-split**
  on sentence boundaries.

So percentile breakpoints are *advisory* — size bounds win on conflict.
A doc with very uneven topic blocks can therefore end up with chunk
boundaries that don't sit exactly on semantic spikes.

**No `headingPath` is set** on semantic chunks (unlike `structure`). The
chunker doesn't consult Markdown headings at all, so retrieved semantic
chunks show only `startChar`/`endChar` in metadata — no section-path
provenance, no `path="A > B > C"` annotation in retrieved chunk listings.

**Pick semantic over structure when:**

- The doc has no usable headings (transcripts, scraped wikis, OCR'd
  text, conversational logs).
- Headings exist but don't match the real topic boundaries — one section
  spans three subjects, or three sections all discuss the same thing.
- You want chunk boundaries to track where the *content* drifts rather
  than where the *markup* changes.

**Caveats to watch for in `--debug`:**

- **Cost.** Structure shows `chunk=0ms`; semantic on a 3000-word doc is
  typically a few hundred ms — one embedding pass per sentence.
- **Naive sentence splitter.** The regex cuts on `.`/`!`/`?` only, so
  abbreviations ("Dr. Smith") and decimals ("0.4%") split early.
  Inspect the chunk inventory in `--debug` if results look off.
- **Model-dependent boundaries.** Same MiniLM weights → same
  breakpoints, but swapping the embedder yields different chunks for
  the same doc. Reproducibility lives at the model-id level, not just
  the config level.
- **Sub-3-sentence docs short-circuit** to a single `sem-0000` chunk
  covering the whole text. Useful to know if you're testing on very
  short inputs and seeing only one chunk.

### Chunk IDs

Each chunker stamps its chunks with a strategy-prefixed id, visible in every
retrieval result and in `--debug` traces. The format encodes where the chunk
came from so you can read locality off the id without joining against
metadata:

| Chunker     | Format                          | Example                                                            |
|-------------|---------------------------------|--------------------------------------------------------------------|
| `size`      | `size-NNNN`                     | `size-0042`                                                        |
| `structure` | `struct-<heading-slug>-<i>`     | `struct-the-calder-hummel-ef.5-material-families.5-2-strontium-doped--13` |
| `semantic`  | `sem-NNNN`                      | `sem-0007`                                                         |

- `NNNN` is the chunk's zero-padded position in the split.
- For `structure`, the slug is built from `headingPath`: each heading is
  lowercased, non-alphanumerics collapsed to `-`, **truncated to 20 chars**,
  then joined with `.`. So "Strontium-doped ruthenates" becomes
  `5-2-strontium-doped-` (the trailing `-` is the boundary after truncation).
  If the doc has no headings, the slug is `root`.
- Trailing `-<i>` on structure ids disambiguates two siblings whose first
  20 heading characters collide within the same chunking run.
- IDs are **stable for a given (doc, chunker config)** but not deduplicated
  across chunkers — `size-0000`, `struct-root-0`, and `sem-0000` can all
  refer to different chunks of the same doc.

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
       │  tokenize +      │           │  Embedder (MiniLM) │
       │  stopword filter │           │  VectorStore       │
       │  inverted index  │           │  cosine via dot    │
       │  BM25 TF + Lucene│           │  (pre-normalized)  │
       │  smoothed IDF    │           │                    │
       │  (k1=1.5, b=.75) │           │                    │
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
why RRF can combine BM25 (unbounded, typically 0–20 in practice) and vector
cosine (mathematically `[-1, 1]`, in practice nearly always positive for
text embeddings) without normalization.

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
System: "You answer questions using ONLY the provided context. Cite chunk
        numbers inline like [1] or [3]. If the context is insufficient to
        answer, say so explicitly — do not invent facts or use outside
        knowledge."

User:   "Context:

         [1] (id=struct-database-migrations.online-schema-change-0, score=0.553)
         <chunk 1 text>

         ---

         [2] (id=struct-database-migrations.backfills-1, score=0.270)
         <chunk 2 text>

         ---

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
| `--debug`               | off        | Emit `[debug]` traces to stderr — see below|
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

### `compare <doc-path> "question" [--k N] [--retrieval MODE] [--generate] [--debug]`

Runs all three chunkers with their defaults on the same query and prints
chunk counts, timings, and top-k for each. `--generate` is off by default to
keep the comparison cheap (skips Claude calls). `--debug` emits the same
per-stage traces described below, once per chunker run.

## Debug mode

`--debug` emits framed `[debug] …` traces to stderr while normal output
keeps going to stdout — so you can `2>debug.log` to separate them, or
`2>&1 | less` to read inline. Every retrieval stage is traced:

```
[debug] runRag: doc=… chunker=structure retrieval=hybrid k=5 generate=true
[debug] chunker config: {"strategy":"structure","maxLevel":3,…}
[debug] loaded doc: 19404 chars
[debug] chunks (27):
  struct-…-overview-1 len=1566 path="… > 1. Overview"
  …
[debug] /chunks (27)
[debug] indexed: vector(27), bm25(27)
[debug] query: "What is the saturation field in strontium ruthenates?"
[debug] bm25 query tokens (after stopwords, n=4): saturation, field, strontium, ruthenates
[debug] vector ranking (top 15, pre-RRF):
  1. struct-…-strontium-doped--13 score=0.6101
  …
[debug] /vector ranking (top 15, pre-RRF)
[debug] bm25 ranking (top 15, pre-RRF):
  1. struct-…-strontium-doped--13 score=7.8308
  …
[debug] /bm25 ranking (top 15, pre-RRF)
[debug] fused RRF top-5:
  1. struct-…-strontium-doped--13 score=0.0328
  …
[debug] /fused RRF top-5
[debug] system prompt:
You answer questions using ONLY the provided context. …
[debug] /system prompt
[debug] user message:
Context:

[1] (id=struct-…-13, score=0.033)
<chunk 1 text>
…
[debug] /user message
```

What this is useful for:

- **"Why didn't my expected chunk get retrieved?"** — see the full chunk
  inventory at chunk time and confirm it's even being indexed.
- **"BM25 found nothing"** — see the tokenized query terms after
  stopword stripping; queries built only of stopwords end up with zero
  candidates.
- **"My hybrid result looks wrong but I can't tell which retriever is
  off"** — the pre-RRF rankings show each retriever's view independently.
- **"What exactly is Claude reading?"** — the prompt blocks show the
  literal system + user message including context block formatting.

For `--retrieval bm25` or `--retrieval vector`, the single ranking is
traced under its retriever name (no `pre-RRF` suffix, no fused block).
For `--no-generate`, the prompt blocks are skipped and you'll see
`skipping generation: --no-generate`.

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
