# API TODOs — Implementation Plan

Source: `// TODO` markers in `~/Documents/my-notes/vault/programming/anthropic/`
(claude-api-documentation-messages.md, courses/anthropic_api.md, courses/mcp-advanced.md,
exam-guide.md, claude-api-managed-agents.md), analyzed against this repo's current state
(HEAD `d8bc17d`). Each item was checked for: what the repo already has, an approach that
fits the existing architecture (CLAUDE.md conventions, `@/` imports, Debug singleton,
args.ts three-place flag convention), and real conflicts.

**Legend:** ✅ landed (implemented in this pass) · ⏸ deferred (conflict —
documented below, not implemented) · ✔ already done before this pass

| # | TODO (notes source) | Feature | Size | Status |
|---|---|---|---|---|
| 1 | messages.md:1264 | Adaptive thinking in streaming (`--thinking`) | M | ✅ landed |
| 2 | anthropic_api.md:182 | Prompt caching (`--cache` + usage report) | S | ✅ landed |
| 3 | messages.md:218 (subset) | Generic `stop_reason: "refusal"` handling | S | ✅ landed |
| 4 | messages.md:964 | Structured outputs — strict tool use remainder | S | ✅ landed |
| 5 | messages.md:1309 | Message Batches API (`eval run --batch`) | M | ✅ landed |
| 6 | messages.md:1407 | `search_result` blocks + citations in rag | M | ✅ landed |
| 7 | messages.md:2181 | Advisor tool (`--advisor`) | M | ✅ landed |
| 8 | messages.md:2393 | Memory tool (`--memory`) | L | ✅ landed |
| 9 | messages.md:4585 | Agent Skills demo (`bun run skills`) | M | ✅ landed |
| 10 | mcp-advanced.md:63,79 | StreamableHTTP MCP server + `--mcp-url` | M | ✅ landed |
| 11 | messages.md:2996 | Programmatic tool calling (`--ptc`) | L | ✅ landed |
| 12 | messages.md:218 | Server-side fallbacks (`fallbacks` param) | M | ⏸ deferred |
| 13 | exam-guide.md:207 | Guaranteed JSON via forced `tool_choice` | S | ⏸ deferred |
| 14 | managed-agents.md:1388 | Managed Agents migration (`--managed`) | L | ⏸ deferred |
| 15 | messages.md:964 (half) | Structured outputs — JSON via `output_config` | — | ✔ done (d8bc17d) |
| 16 | messages.md:4752 | Client-side MCP helpers | — | ✔ done (src/mcp) |

Verified after implementation: `bun run check` and `bun run typecheck` both
clean; `--help` / parse paths of the main CLI and every sub-CLI (eval, rag,
mcp, skills, mcp:http-server) exercised without API calls, the HTTP MCP server
smoke-tested over a real `initialize` + `tools/list` round-trip, and the memory
tool's containment checks exercised offline. Items 12–14 are confirmed absent
from `src/` (no `fallbacks`, no `tool_choice`, no `src/managed/`).

### Deviations from the plan, as landed

All deviations are additive tightenings; each is documented in the CLAUDE.md
of the module it affects.

- **7 (advisor)** — the parse-time exclusion set grew from
  `--tools`/`--mcp` to also cover `--mcp-url` and `--memory` (both force the
  agentic branch, which the advisor path bypasses). See `src/cli/CLAUDE.md`.
- **8 (memory)** — `memories/` is gitignored, and `--memory`'s optional value
  uses a *path-shaped* heuristic (leading `.`/`/`/`~`, or an embedded `/`)
  rather than the name-list heuristic `--tools`/`--mcp` use.
- **10 (HTTP MCP)** — `--json-response` shipped alongside `--stateless` as
  planned; the server's own flag parser also prints `error: …` + usage instead
  of throwing, matching the main CLI.
- **11 (PTC)** — two exclusions beyond the planned `--mcp` / `--runner sdk`
  pair: `--ptc` also rejects `--advisor` and *requires* `--tools` (there is
  nothing for the container to script otherwise). The four rules are tabulated
  in `src/cli/CLAUDE.md`; the mechanics live in `src/core/tools/CLAUDE.md`.
- **5 (batches)** — scope is `eval run` only, as planned; `gen`/`grade` stay
  sequential because `beta.messages.parse` has no batch equivalent. Recorded
  as a follow-up in `src/eval/CLAUDE.md`.

---

## Items to implement

### 1. Adaptive thinking with streamed rendering — `--thinking`

- **Feature:** `thinking: {type: "adaptive"}` on claude-sonnet-4-6 (GA, no beta header);
  streamed as `thinking` content blocks with `thinking_delta` / `signature_delta` events.
  The notes' `budget_tokens` form is deprecated on 4.6 — adaptive only.
- **Repo state:** plumbing mostly exists. `StreamAssistantOptions` is
  `Partial<Omit<MessageStreamParams, "messages">>`, so `thinking` flows through with zero
  new core surface; history replay works for free because full assistant content is pushed
  (messages.ts) and both agentic runners preserve it. Missing: the flag, and rendering —
  both stream consumers (`repl.ts` sendTurn onStream, `hooks.ts` buildAgenticHooks) wire
  only `stream.on("text")`, so thinking deltas are silently dropped.
- **Plan:** bare `--thinking` flag (args.ts three-place convention); include
  `thinking: {type:"adaptive"}` in requestOpts in sendTurn (flows through both single-shot
  and agentic paths). Render thinking deltas to **stderr** (dim `[thinking]` prefix; stdout
  stays reserved for answer text); ignore `signature_delta` for display. Guards: parse-time
  error for `--thinking` + `--prefill` (prefill 400s on 4.6 anyway); warn/auto-bump when
  running with the 1024 `DEFAULT_MAX_TOKENS`, since `max_tokens` caps thinking + answer.
- **Files:** `src/cli/args.ts`, `src/cli/repl.ts`, `src/cli/hooks.ts`.

### 2. Prompt caching — `--cache`

- **Feature:** top-level auto-caching `cache_control: {type:"ephemeral"}` (places the
  breakpoint on the last cacheable block); verify via `usage.cache_read_input_tokens` /
  `cache_creation_input_tokens`. Minimum cacheable prefix on sonnet-4-6 is 1024 tokens.
- **Repo state:** no `cache_control` anywhere. Best payoffs here: multi-turn REPL history
  (resent every turn), MCP `@resource` attachments, long `--system` prompts.
- **Plan:** bare `--cache` flag; rides the existing pass-through option types (no core
  changes). After each turn print a stderr line:
  `[cache] read=<n> wrote=<n> uncached=<n>`. Help text notes the 1024-token minimum and
  that `--mcp` + a resource mention is the easy way to see a hit. Deliberate divergence
  from the notes: top-level auto-cache instead of manual 4-breakpoint management — simpler
  GA mechanism, adequate for this repo.
- **Files:** `src/cli/args.ts`, `src/cli/repl.ts` (+ optional usage in agentic onRound).

### 3. Refusal handling (model-agnostic subset of the fallback TODO)

- Any Claude 4+ model can return `stop_reason: "refusal"`; today the REPL would print an
  empty line silently. Add a branch in `repl.ts` printing `stop_details.category` /
  `.explanation` (null-guarded) to stderr. Always-on, no flag. The `fallbacks` parameter
  itself is deferred — see item 12.

### 4. Strict tool use (the un-done half of structured outputs)

- **Repo state:** JSON outputs half landed in `d8bc17d` (`parseAssistantMessage` +
  eval dataset/judge). `strict: true` appears nowhere.
- **Plan:** set `strict: true` on the `defineTool` result in `src/core/tools/define.ts`
  (must go on the returned object — `betaZodTool`'s options type doesn't accept it; the
  underlying `BetaTool` shape does). All four builtins have all-required schemas, so they
  qualify. Verify with `--debug` that the Zod→JSON-schema conversion emits
  `additionalProperties: false`; post-process in defineTool if not. **MCP-sourced tools
  stay non-strict** (server schemas may not satisfy strict's constraints → 400 risk).
- **Files:** `src/core/tools/define.ts`, `src/core/tools/CLAUDE.md`, root `CLAUDE.md`.

### 5. Message Batches API — `eval run --batch`

- **Feature:** `client.messages.batches.create` → poll `retrieve` until
  `processing_status === "ended"` → stream `.results()`; 50% cost; results arrive in
  arbitrary order, keyed by `custom_id`.
- **Repo state:** `src/eval/runner.ts` `runPromptOnDataset` loops sequentially over
  independent dataset items — the Batches headline use case.
- **Plan:** new `src/core/batches.ts` (`runMessageBatch(requests, {pollMs}) → Map by
  custom_id`, Debug-traced polling), exported from the core barrel. In runner.ts, branch on
  `--batch`: one request per item (`custom_id: item-${i}`, mirroring the sequential path's
  params), reassemble **in dataset order** (row-index joins downstream would silently
  mispair otherwise), errored/expired rows get `output: ""` + stderr warning so
  `RunRowSchema` still validates. Same output file → caching contract and
  code/grade/combined untouched. Scope: `run` only — `gen`/`grade` use `beta.messages.parse`
  which has no batch equivalent (documented follow-up).
- **Files:** `src/core/batches.ts` (new), `src/core/index.ts`, `src/eval/runner.ts`,
  `src/eval/cli.ts`, `src/eval/CLAUDE.md`, `src/core/CLAUDE.md`.

### 6. Search-result content blocks + citations in rag

- **Feature:** `{type:"search_result", source, title, content:[text], citations:{enabled:true}}`
  blocks in the user turn; the model's answer text blocks then carry a structural
  `citations` array (`search_result_location`) — verifiable citations instead of
  prompt-begged `[n]` indices. GA, no beta header, works on sonnet-4-6.
- **Repo state:** `src/rag/generate-answer.ts` is exactly the baseline this replaces:
  hand-rolled `<chunk>` XML + a system prompt asking for `[1]`-style citations by
  convention; citations metadata is discarded by `extractText`.
- **Plan:** build one `SearchResultBlockParam` per retrieved chunk (`source:
  doc://<chunk.id>`, `title: headingPath.join(" > ")`), push a block-array user turn,
  drop the manual citation instruction from SYSTEM. `answerWithClaude` returns
  `{text, citations[]}` (walk final content; streaming via onText unchanged — sources
  rendered after the stream ends from finalMessage). CLI prints a `=== sources ===`
  section (deduped `[n] title — source` + cited_text snippet). Optional `--no-citations`
  fallback to the XML path for side-by-side comparison. Note: citations are incompatible
  with `output_config.format` (400) — leave a comment.
- **Files:** `src/rag/generate-answer.ts`, `src/rag/rag.ts`, `src/rag/cli.ts`,
  `src/rag/README.md` (rag-internal block push; core `addUserMessage` stays string-only).

### 7. Advisor tool — `--advisor [model]`

- **Feature:** server-side `{type:"advisor_20260301", name:"advisor", model}` with beta
  `advisor-tool-2026-03-01` on `client.beta.messages`. Executor claude-sonnet-4-6 (repo
  default) + advisor claude-opus-4-8 is a valid pairing, and opus-4-8 returns **plaintext**
  advice (`advisor_result`), so there is something visible to demo.
- **Plan:** `ADVISOR_MODEL = "claude-opus-4-8"` in constants; new core primitive
  `src/core/advisor.ts` (`streamAdvisorMessage` — beta stream + tools entry, pushes full
  final content into history). `--advisor [model]` flag (bare = ADVISOR_MODEL). Render
  `advisor_tool_result` by switching on the content union (`advisor_result` → stderr trace,
  `advisor_redacted_result` → `[advisor] redacted`, error → warning) — never read `.text`
  unconditionally. Once an advisor block is in history the tool must stay in every later
  request (else 400) — fine, flags are per-session. v1 mutually exclusive with
  `--tools`/`--mcp` (parse-time error); ignores `--prefill`.
- **Files:** `src/core/constants.ts`, `src/core/advisor.ts` (new), `src/core/index.ts`,
  `src/cli/args.ts`, `src/cli/repl.ts`, `src/core/CLAUDE.md`, `src/cli/CLAUDE.md`.

### 8. Memory tool — `--memory [dir]`

- **Feature:** Anthropic-defined client-side tool `{type:"memory_20250818", name:"memory"}`
  (no input_schema — built into the model): commands view/create/str_replace/insert/
  delete/rename against a local `./memories` dir; path-traversal validation required.
- **Repo impact (the invasive part):** the tools module is built around `betaZodTool`
  custom tools; an Anthropic-defined tool has no `input_schema` and must be sent verbatim
  as `{type, name}`. This forces widening `Tool` in `types.ts` to a union and passing
  Anthropic-defined defs through the local runner's `toolDefs` projection verbatim. That
  generalization is **shared with PTC (item 11)** — land it here once.
- **Plan:** `src/core/tools/memory.ts`: filesystem backend (default `./memories`,
  gitignored) implementing the six commands with canonical-path containment checks;
  handlers shaped as the SDK's `MemoryToolHandlers` so the SDK runner uses
  `betaMemoryTool(handlers)` verbatim and the local runner reuses them via a
  command-dispatch `run`. Gating: do **not** add "memory" to `MUTATING_TOOLS` wholesale
  (would y/N-prompt `view` and break the piped path) — treat sandboxed `./memories` writes
  as non-mutating, documented in tools/CLAUDE.md.
- **Files:** `src/core/tools/memory.ts` (new), `types.ts`, `agentic.ts`,
  `agentic_sdk.ts`, `tools/index.ts`, `src/cli/args.ts`, `src/cli/repl.ts`,
  `tools/CLAUDE.md`, `.gitignore`.

### 9. Agent Skills demo — new `bun run skills` sub-CLI

- **Feature:** `client.beta.messages.stream` with betas
  `["code-execution-2025-08-25","skills-2025-10-02"]`,
  `container: {skills: [{type:"anthropic", skill_id, version:"latest"}]}`, and the
  `code_execution_20260521` tool (the notes' `code_execution_20250825` is stale); walk
  the response for generated-file IDs; download via Files API
  (`client.beta.files.download`, header auto-sent).
- **Plan:** doesn't fit the conversational main CLI (container + dual betas + filesystem
  side effects) → standalone sub-CLI per the repo's eval/rag/mcp pattern, built on
  `@/core/cli.ts`. `bun run skills generate --skill pptx|xlsx|docx|pdf --out <dir>
  [--model id] [--debug] "<prompt>"` — skill validated at parse time as a literal union
  (fb9df26 convention); `path.basename` sanitization before writing artifacts.
  Also introduces Files-API download handling, which the repo lacks entirely.
- **Files:** `src/skills/cli.ts` + `index.ts` (new), `package.json`, root `CLAUDE.md`,
  `.gitignore` (`skills-out/`).

### 10. StreamableHTTP MCP server + `--mcp-url`

- **Feature:** MCP over HTTP — server assigns a session ID at initialize, client echoes it
  as a header; GET opens the SSE stream that carries server→client requests (sampling,
  roots). Knobs from the notes: stateless mode (`sessionIdGenerator: undefined` — kills
  server→client) and `enableJsonResponse`. The installed `@modelcontextprotocol/sdk`
  ^1.29.0 ships `WebStandardStreamableHTTPServerTransport` (fetch Request/Response —
  natural fit for `Bun.serve`) and `StreamableHTTPClientTransport`.
- **Plan:** extract a `buildDocsServer()` factory from docs-server.ts (stdio entry keeps
  calling it; `resolveDocsDir()` stays lazy per src/mcp/CLAUDE.md). New
  `src/mcp/servers/http-docs-server.ts`: `Bun.serve` routing POST/GET/DELETE at `/mcp`
  through the transport, session map keyed by `crypto.randomUUID()`, `--port` (default
  3100), `--stateless`, `--json-response`. Client: `connectMcpServerHttp(name, url)` in
  connection.ts reusing the `McpConnection` shape + same sampling/roots handlers — in
  stateless mode those degrade to the existing graceful fallbacks, which is itself the
  demo of why statelessness kills server→client features. Main CLI: repeatable
  `--mcp-url <url>` merged into the same connections array (stdio `--mcp` registry
  untouched). New `mcp:http-server` script.
- **Files:** `src/mcp/servers/http-docs-server.ts` (new), `docs-server.ts`,
  `client/connection.ts`, `client/index.ts`, `src/mcp/index.ts`, `src/cli/args.ts`,
  `src/cli/index.ts`, `package.json`, `src/mcp/CLAUDE.md`.
- Also unblocks the only missing half of TODO 16 (client-helpers vs server-side MCP
  connector comparison) — though a live connector demo still needs a tunnel, since
  Anthropic's API can't reach localhost.

### 11. Programmatic tool calling — `--ptc` (implement last; cut first if needed)

- **Feature:** `{type:"code_execution_20260120"}` + `allowed_callers:
  ["code_execution_20260120"]` on custom tools; Claude scripts your tools from the
  server-side container; replies to pending programmatic calls must be tool_result-only
  user messages. No beta header; sonnet-4-6 supported. **Hard API incompatibilities:**
  `strict: true`, forced `tool_choice`, `disable_parallel_tool_use`, MCP tools.
- **Repo fit:** the local loop already replies with tool_result-only user messages
  (the PTC requirement) and uses the non-beta API. Needed extensions: verbatim
  server-tool defs (shared with item 8), `allowed_callers` pass-through, threading
  `response.container?.id` across iterations, and treating `stop_reason === "pause_turn"`
  as continue.
- **Constraints (accepted, documented):** parse-time mutual exclusion with `--mcp`
  (first non-composing flag pair in the CLI) and with `--runner sdk` (toolRunner doesn't
  auto-resume pause_turn) — breaks the two-runner parity invariant, local-runner-only,
  documented in tools/CLAUDE.md. Note interaction with item 4: builtins get
  `strict: true` by default, and strict is incompatible with PTC — under `--ptc` the
  strict field must be dropped from the tool defs.
- **Files:** `src/core/tools/agentic.ts`, `types.ts`, `src/cli/args.ts`,
  `src/cli/repl.ts`, `src/cli/hooks.ts`, `tools/CLAUDE.md`, `src/cli/CLAUDE.md`.

---

## Deferred — conflicts, revisit later

### 12. Server-side refusal fallbacks (messages.md:218) — ⏸

The `fallbacks` request parameter (beta `server-side-fallback-2026-06-01` array form /
`-2026-07-01` "default" scalar) only fires on classifier refusals, which only
claude-fable-5 / claude-opus-5 produce — the repo's default claude-sonnet-4-6 never
returns them and is not a valid fallbacks source. It would also force the main request
path onto `client.beta.messages` (core/messages.ts is deliberately non-beta except
`parse`), and there is no realistic way to trigger a refusal on demand, so the path would
ship unexercised. **Revisit when the repo adopts an Opus-5-tier model.** The
model-agnostic subset (refusal stop_reason handling) is implemented as item 3.

### 13. Guaranteed JSON via forced tool_choice (exam-guide.md:207) — ⏸

Superseded in this repo: commit `d8bc17d` migrated the two guaranteed-JSON consumers
(eval dataset gen + judge) to SDK structured outputs, and `parseAssistantMessage` is a
core primitive with a strictly stronger contract (schema-constrained decoding + Zod
validation) than tool_use-block extraction. Re-adding the forced-tool pattern would
resurrect what that commit deleted. Also: in the agentic loop, forced `tool_choice` must
be dropped after round one or the loop never terminates, and the SDK runner has no clean
per-round override — splitting the two runners the repo keeps at parity. If the mechanic
is ever wanted for its own sake, the right shape is a scoped `--force-tool <name>` flag
applied on the first local-runner iteration only.

### 14. Managed Agents migration (managed-agents.md:1388) — ⏸

An L-sized parallel product surface, not an incremental feature. Direct conflicts:

- CMA moves conversation state server-side — contradicts the repo's load-bearing
  invariant that the local `messages` array is the source of truth; `--prefill`,
  `--stop`, `--temperature`, `--stream`, `--runner` have no CMA equivalent
  (model/system/tools live on the persisted agent, not per request).
- Local **stdio** MCP servers can't attach to a Managed Agent (URL servers only, publicly
  reachable, vault-held credentials) — the entire src/mcp sampling/roots showcase doesn't
  carry over. Item 10 (HTTP MCP server) is a soft prerequisite, plus tunneling/deployment.
- The y/N mutating-tool gate maps to a different mechanism (`permission_policy:
  always_ask` + `user.tool_confirmation` events) — a redesign, not a port.
- Agents/environments are persistent versioned resources needing a setup-vs-runtime split
  (stored IDs) the repo has no pattern for; requires beta access; sandbox runtime billing.

**Recommended first step when appetite exists:** a self-contained `src/managed/` sub-CLI
spike (`managed setup` persisting `{environment_id, agent_id, version}` to a gitignored
`.managed.json`; `managed run "<prompt>"` via `sessions.create` + `initial_events` +
stream-first event loop breaking on terminated / non-`requires_action` idle). That proves
the event-stream and ID-persistence patterns (~M effort) without touching the existing
harness. The `--managed` flag on the main CLI stays a later, separate decision.

---

## Already covered

- **15. Structured outputs, JSON half (messages.md:964):** done in `d8bc17d` —
  `parseAssistantMessage` (core) + eval dataset gen/judge. Only the strict-tools remainder
  is open (item 4).
- **16. Client-side MCP helpers (messages.md:4752):** `src/mcp/` already uses `mcpTools`
  / `mcpMessages` / `mcpResourceToContent`, with a cleaner `isMcpClientLike()` guard than
  the note's own snippet (`mcpRunnableTools()` in client/tools.ts). The only open half of
  a "compare" is the server-side MCP connector (`mcp_servers` + `mcp_toolset`, beta
  `mcp-client-2025-11-20`), blocked on item 10 + a public tunnel — folded into item 10's
  follow-ups.

---

## Implementation order & gates

Wave 1 (independent, parallel — disjoint files):
- item 5 (eval batch), item 6 (rag citations), item 9 (skills sub-CLI),
  and the CLI chain: item 1+2+3 (thinking/cache/refusal) → item 7 (advisor) →
  item 8+4 (memory + strict) → item 11 (PTC).

Wave 2 (after everything, touches shared files): item 10 (HTTP MCP + `--mcp-url`).

Every step must pass both correctness gates: `bun run check` and `bun run typecheck`.
No test suite exists; features are verified by running the relevant CLI paths.
