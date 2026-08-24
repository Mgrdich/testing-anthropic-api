# `src/core/tools/`

Anthropic tool-use loop and the built-in tool registry. Consumed by
`cli/repl.ts` and reusable by any non-CLI caller (e.g. `eval/`).

## Layout

- `types.ts` — the `Tool` union and the `isAnthropicDefinedTool`
  narrowing predicate (see "Two tool flavors" below).
- `define.ts` — `defineTool({ name, description, inputSchema, run, close? })`,
  a thin wrapper around the SDK's `betaZodTool` from
  `@anthropic-ai/sdk/helpers/beta/zod`. The SDK does the Zod → JSON
  schema conversion and produces both `run` (executor) and `parse`
  (Zod validator); we just narrow the SDK's wider `BetaRunnableTool`
  union to our `CustomTool` shape and turn on **strict tool use**.
- `memory.ts` — the Anthropic-defined memory tool
  (`memory_20250818`) over a local directory. See "Memory tool" below.
- One file per tool — each exports a single `Tool` value built with
  `defineTool`:
  - `echo.ts` — `echo` (the worked example below)
  - `get_time.ts` — `getTime`
  - `calculator.ts` — `calculator`
  - `get_weather.ts` — `getWeather`
- `builtins.ts` — imports each tool and exposes the `BUILTIN_TOOLS`
  registry, `selectTools(filter)`, and the `MUTATING_TOOLS` name set
  (the sidecar that drives the approval gate, since `betaZodTool`'s
  return type doesn't carry a `mutating` flag).
- `agentic.ts` — `runAgenticTurn(messages, opts, tools, hooks)`, our
  hand-rolled tool-use loop. Calls `tool.parse(rawInput)` →
  `tool.run(parsed)` per call, matching the SDK's own
  `runRunnableTool` pattern.
- `agentic_sdk.ts` — `runAgenticTurnSdk(messages, opts, tools, hooks)`,
  same signature as `runAgenticTurn` but backed by Anthropic's
  `client.beta.messages.toolRunner()`. The REPL picks between them via
  `--runner local|sdk` (default `local`).
- `index.ts` — public barrel; re-exported from `@/core/index.ts`.

## Public surface

```ts
type ToolExecutor = {
  run: (input: unknown) => Promise<string> | string;
  parse?: (content: unknown) => unknown;
};
type CustomTool = BetaTool & ToolExecutor;              // we own the schema
type AnthropicDefinedTool = ToolExecutor & {            // model owns the schema
  type: string; name: string; input_schema?: never;
};
type Tool = CustomTool | AnthropicDefinedTool;
function isAnthropicDefinedTool(tool: Tool): tool is AnthropicDefinedTool;

const BUILTIN_TOOLS = { … } satisfies Record<string, Tool>; // keys stay literal
type BuiltinToolName = keyof typeof BUILTIN_TOOLS;
function isBuiltinToolName(name: string): name is BuiltinToolName;
const MUTATING_TOOLS: ReadonlySet<string>;
function selectTools(filter: "all" | readonly BuiltinToolName[]): Tool[];
function defineTool<S extends z.ZodType>(spec: BetaZodToolParams<S>): CustomTool;

function createMemoryTool(dir?: string): Tool;          // memory_20250818
function createMemoryHandlers(dir?: string): MemoryToolHandlers;
const DEFAULT_MEMORY_DIR = "./memories";
const MEMORY_TOOL_NAME = "memory";
const MEMORY_TOOL_TYPE = "memory_20250818";

type ToolCaller = "direct" | "code_execution_20250825" | "code_execution_20260120";
const PTC_TOOL_TYPE = "code_execution_20260120";
const PTC_CODE_EXECUTION_TOOL: Anthropic.ToolUnion;   // {type, name}

type RunAgenticOptions = StreamAssistantOptions & {
  max_iterations?: number;                    // unset = unbounded
  server_tools?: readonly Anthropic.ToolUnion[];  // appended verbatim
  allowed_callers?: readonly ToolCaller[];    // stamped on client tool defs
  omit_strict?: boolean;                      // drop strict (PTC)
};

type AgenticHooks = {
  onStream?: (stream: MessageStream) => void;
  onRound?: (info: { iteration; stop_reason; tool_use_blocks }) => void;
  onToolCall?: (name, input, caller?) => void;
  onToolResult?: (name, result, isError) => void;
  isMutating?: (name: string) => boolean;
  approveMutating?: (name, input) => Promise<boolean>;
};

function runAgenticTurn(
  messages: MessageParam[],
  opts: RunAgenticOptions,
  tools: readonly Tool[],
  hooks?: AgenticHooks,
): Promise<Anthropic.Message>;
```

## Two tool flavors

`Tool` is a union, and the split is about **who owns the input schema**:

- **`CustomTool`** — ours. Carries `input_schema` (Zod-derived by
  `defineTool`, or hand-rolled), and goes on the wire as
  `{name, description, input_schema, strict?}`. Built-ins and
  MCP-sourced tools are all this flavor.
- **`AnthropicDefinedTool`** — the model already knows the schema, so
  the wire form is just `{type, name}` and there is nothing else to
  send. `memory_20250818` is the first one; the code-execution tool for
  programmatic tool calling is next. The executor still runs
  client-side, exactly like a custom tool.

`isAnthropicDefinedTool(tool)` narrows on the **absence of
`input_schema`**, not on a `type` allowlist — a new server-shaped tool
passes through the projection without touching the predicate. Only one
place cares about the difference: `runAgenticTurn`'s `toolDefs`
projection, which sends `{type, name}` verbatim for the Anthropic-defined
branch. `runAgenticTurnSdk` needs no branch at all — it spreads each
tool's wire fields through to the SDK runner, so an Anthropic-defined
tool arrives exactly as the SDK's own helper built it.

There is a **third** thing that reaches the wire `tools` array and is
deliberately *not* a `Tool`: an **Anthropic-hosted (server-side) tool**,
passed as `opts.server_tools` and appended to `toolDefs` verbatim. It has
no local executor — the API both owns its schema and runs it — so putting
it in the `Tool` union would mean a `run` that must never be called.
`PTC_CODE_EXECUTION_TOOL` is the only one today.

Execution is uniform: `executeToolCall` calls `parse` when present and
otherwise hands the raw input to `run`, so both flavors dispatch through
the same path.

## Strict tool use

`defineTool` sets **`strict: true`** on every tool it produces (no beta
header; the API guarantees `tool_use.input` validates against the schema
exactly, which removes a class of malformed-input retries). Two
mechanics worth knowing before you touch it:

- `strict` has to go on the **returned object**, not through
  `betaZodTool`'s options — that options type has no `strict` field,
  while the `BetaTool` shape it produces does. Hence the single cast in
  `define.ts`.
- The API requires the schema to carry `additionalProperties: false`
  next to `required`. Zod v4's JSON-schema conversion already emits it
  for `z.object(...)`, so `defineTool` only *normalizes* — it fills the
  field in when a schema shape doesn't. Keep that guard: a strict tool
  whose schema is open 400s.

All four built-ins have all-required, closed schemas, so they qualify
as-is. **MCP-sourced tools stay non-strict** (`mcp/client/tools.ts` never
sets the flag): those schemas come from third-party servers and may not
satisfy strict's constraints, and a 400 there would take down the whole
turn. `strict` is forwarded by the `toolDefs` projection, so anything
that does set it keeps it on the wire — **except** under
`omit_strict: true`, which the PTC path sets because the API rejects
strict tool use together with programmatic tool calling.

## Programmatic tool calling (PTC)

`{type: "code_execution_20260120", name: "code_execution"}` in the wire
`tools` array, plus `allowed_callers: ["code_execution_20260120"]` on
each of our own tools, flips tool use inside out: instead of the model
calling one tool per round, it writes a **script** that runs in the API's
code-execution container and calls our tools as functions. Intermediate
results go to the running script, not into the model's context — only the
script's final output comes back. No beta header; sonnet-4-6 supports it.

The loop needs three things beyond the ordinary path, all in
`runAgenticTurn`:

1. **Projection.** `server_tools` are appended verbatim;
   `allowed_callers` is stamped onto every *client-side* tool def (both
   flavors) and never onto the server tool; `omit_strict` drops `strict`.
2. **Container threading.** `response.container?.id` is captured after
   every round and spread back as `{container: id}` on the next request,
   so the sandbox (and its REPL state) survives the whole turn. It is
   request-scoped state, deliberately *not* part of `messages`.
3. **`pause_turn` is "continue".** The API's own server-side loop pauses
   long-running turns with `stop_reason === "pause_turn"`. The assistant
   turn is already in history (pushed by `streamAssistantMessage`), so
   resuming is re-sending the conversation as-is — **no user message and
   no tool dispatch**. `max_iterations` is checked before the resume, so
   a pathological pause loop still hits the cap; when it does, the
   returned message carries `stop_reason === "pause_turn"` (the caller's
   cap detection must accept both it and `"tool_use"`).

Everything else already fit: PTC requires replies to pending
programmatic calls to be **tool_result-only user messages**, which is
exactly what this loop has always pushed, and it uses the non-beta
Messages API, which is what `streamAssistantMessage` calls.

**PTC is local-runner-only, and that breaks the two-runner parity
invariant on purpose.** `runAgenticTurnSdk` ends its loop on `pause_turn`
instead of resuming, so a paused container turn would come back silently
truncated; it also forwards unrecognized option keys straight into the
request body, so `server_tools`/`allowed_callers`/`omit_strict` would
become unknown request fields. Nothing guards that at the type level —
the **parse-time `--ptc` vs `--runner sdk` error in `cli/args.ts` is what
keeps the combination unreachable.** Same for `--mcp`: the API rejects
MCP tools alongside the code-execution tool, so that pair is a parse-time
error too rather than a runtime 400.

One caveat worth knowing: `allowed_callers` is stamped on *every*
client-side tool, so `--memory` under `--ptc` makes the memory tool
container-only as well. That is consistent (everything moves behind the
script) but it is not a per-tool choice today.

## Memory tool

`createMemoryTool(dir)` returns the SDK's `betaMemoryTool(handlers)`
product — `{type: "memory_20250818", name: "memory", parse, run}` where
`run` dispatches on `input.command` — backed by
`createMemoryHandlers(dir)`, a filesystem implementation of the six
commands (`view`, `create`, `str_replace`, `insert`, `delete`,
`rename`). Shaping the backend as the SDK's `MemoryToolHandlers` is what
lets one object serve both runners: the SDK path consumes it verbatim,
and the local path reaches the same handlers through the helper's
command dispatch.

The CLI wires it with `--memory [dir]` (default `./memories`,
gitignored), which forces the tools branch on even without `--tools`.

**Containment is the security boundary.** Every handler resolves its
model-supplied path through one function, `resolveMemoryPath`, which
does two checks:

1. An absolute path must address the virtual root (`/memories` or
   `/memories/…`). Anything else — `/etc/passwd`, `/memories-evil/x` —
   is rejected rather than silently reinterpreted as relative.
2. The path is canonicalized with `path.resolve` and must then be the
   root or a descendant (prefix check *including* the separator). This
   is what stops `..` traversal.

Symlinks inside the directory are not resolved through, and there is no
per-user scoping: this is a demo store on the local filesystem, not a
multi-tenant boundary. Don't put secrets in it.

**`"memory"` is deliberately *not* in `MUTATING_TOOLS`.** The set gates
by tool *name*, and the memory tool multiplexes read and write commands
behind one name — adding it would y/N-prompt on `view` and hard-fail the
one-shot/piped path (which has no TTY) on the very first read. Writes are
confined to a gitignored sandbox directory, so they're treated as
non-mutating. If per-command gating is ever wanted, the hook needs to
take the parsed input, not just the name.

## Loop invariants

`runAgenticTurn` calls `streamAssistantMessage` in a loop and breaks
when `stop_reason` is neither `"tool_use"` nor `"pause_turn"` (the two
resumable reasons — see "Programmatic tool calling" above for
`pause_turn`). The assistant turn (including any
`tool_use` blocks) is pushed by `streamAssistantMessage`; this module
only appends the user/`tool_result` turn between iterations. The loop
always uses streaming — `args.stream` does not apply to the tools
path. `args.prefill` is also not threaded through this loop; combine it
with the single-shot path instead.

**Tool dispatch order within a round:** when the model emits multiple
`tool_use` blocks in one assistant turn, the loop runs them in two
phases:

1. **Serial approval pass** — `onToolCall` fires for each, then
   `approveMutating` (if applicable) is awaited one at a time. y/N
   prompts can't sensibly interleave on the same readline interface.
2. **Parallel execution pass** — approved tools are dispatched via
   `Promise.all`, matching the SDK's `toolRunner` behavior.
   `onToolResult` fires as each completes (interleaved by speed, not
   model order). The `tool_result` blocks pushed back to the model are
   still in the model's original order — `Promise.all` preserves array
   index.

**`max_iterations`:** caps API calls. Each iteration = one assistant
response + one tool round (or one `pause_turn` resume). When the cap is
hit, the function returns the last assistant message — which still
carries a resumable `stop_reason` (`"tool_use"`, or `"pause_turn"` under
PTC), letting callers detect the cap fired (the REPL prints a warning).
Unset means unbounded. Both runners honor it identically.

## Two runners

The module exports two loops with the same signature:

- **`runAgenticTurn`** (local, default) — the hand-rolled loop in
  `agentic.ts`. Two-phase dispatch per round (serial approval, then
  parallel `Promise.all` execution). Fires hooks (`onToolCall`,
  `onToolResult`, `onRound`) directly from the loop body.
- **`runAgenticTurnSdk`** (`--runner sdk`) — calls
  `client.beta.messages.toolRunner()` and translates the runner's
  async-iterable surface into our `AgenticHooks`. Hook fan-out happens
  via wrappers around each tool's `run` (the SDK doesn't expose
  per-call events). Behind a `--runner sdk` flag and uses the **beta
  messages API** — pass `betas: ["agentic-tool-use-2025-05-18"]` in
  `apiOpts` if the model rejects the request.

Both runners produce identical hook event sets and equivalent
post-call `messages` arrays for the same scripted assistant responses
(verified by a mocked parity test).

**Behavioral divergences** (all in `agentic_sdk.ts`, except the first,
which is a capability gap):
- **Programmatic tool calling is local-only.** `runAgenticTurnSdk`
  neither resumes `pause_turn` nor understands the PTC options; the
  `--ptc` / `--runner sdk` parse-time error is the guard. See
  "Programmatic tool calling" above.
- The SDK runner dispatches via `Promise.all` without our serial-
  approval phase. Multiple concurrent mutating-tool calls race their
  `approveMutating` prompts — fine today (no mutating tools) but if
  bash/write_file land, add a process-wide mutex around
  `approveMutating` in the wrapper.
- `messages` is structurally cloned by the runner; `runAgenticTurnSdk`
  syncs the runner's final state back into the caller's array after
  the loop completes (replaces the array contents in place).
- `AbortSignal` is not plumbed today. The SDK runner accepts a
  `signal` in its options arg and tool authors receive
  `context.signal`; ready to wire if the REPL ever needs cancellation.

## Adding a tool

Use `defineTool` — it delegates to the SDK's `betaZodTool`, which
derives `input_schema` from your Zod schema and produces a `parse`
function the executor uses to validate the model's input before
calling `run`:

```ts
// src/core/tools/echo.ts
import { z } from "zod";
import { defineTool } from "@/core/tools/define.ts";

export const echo = defineTool({
  name: "echo",
  description: "Returns the given text verbatim.",
  inputSchema: z.object({
    text: z.string().describe("Text to echo back"),
  }),
  run: ({ text }) => text,           // typed as { text: string }
});
```

Then import it in `builtins.ts` and add it to `BUILTIN_TOOLS`.

If the tool has side effects, add its name to `MUTATING_TOOLS` (the
sidecar `Set<string>` in `builtins.ts`). The REPL wires `isMutating`
+ `approveMutating` into the hooks so each call to a mutating tool
prompts y/N; the one-shot/piped path throws because no TTY is
available.

**Field descriptions:** use `.describe("…")` on each Zod field — the
text becomes the `description` in the generated JSON Schema, which is
what the model reads to decide how to call the tool.

**Direct `Tool` values** (skipping `defineTool`) are still supported if
you need a hand-rolled `input_schema` or an input shape that isn't an
object — `BUILTIN_TOOLS` just stores `Tool`, not factory output. Such
tools won't have a `parse` field, and the executor falls through to
`run(rawInput)` directly. They also won't be `strict` unless you set the
flag yourself, and a hand-rolled schema that isn't closed
(`additionalProperties: false`) must *not* be marked strict.

**Adding another Anthropic-defined tool** (text editor, code execution):
build the `{type, name}` object with its executor, return it as `Tool`,
and stop — no schema, no registry entry needed for the projection to
work. `memory.ts` is the worked example.

## Security boundary for `calculator`

The character whitelist regex `^[\d+\-*/().\s]+$` is what makes the
`new Function(...)` evaluator safe — it admits only arithmetic, no
identifiers or calls. Do not relax this regex without replacing the
evaluator with a real parser.
