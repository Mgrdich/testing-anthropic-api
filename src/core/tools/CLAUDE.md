# `src/core/tools/`

Anthropic tool-use loop and the built-in tool registry. Consumed by
`cli/repl.ts` and reusable by any non-CLI caller (e.g. `eval/`).

## Layout

- `types.ts` — the `Tool` type (`BetaTool & { run, parse? }`, where
  `BetaTool` is imported from `@anthropic-ai/sdk/resources/beta` — the
  variant `betaZodTool` actually produces).
- `define.ts` — `defineTool({ name, description, inputSchema, run, close? })`,
  a thin wrapper around the SDK's `betaZodTool` from
  `@anthropic-ai/sdk/helpers/beta/zod`. The SDK does the Zod → JSON
  schema conversion and produces both `run` (executor) and `parse`
  (Zod validator); we just narrow the SDK's wider `BetaRunnableTool`
  union to our `Tool` shape.
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
type Tool = BetaTool & {
  run: (input: unknown) => Promise<string> | string;
  parse?: (content: unknown) => unknown;
};

const BUILTIN_TOOLS: Record<string, Tool>;
const MUTATING_TOOLS: ReadonlySet<string>;
function selectTools(filter: "all" | readonly string[]): Tool[];
function defineTool<S extends z.ZodType>(spec: BetaZodToolParams<S>): Tool;

type RunAgenticOptions = StreamAssistantOptions & {
  max_iterations?: number;       // unset = unbounded
};

type AgenticHooks = {
  onStream?: (stream: MessageStream) => void;
  onRound?: (info: { iteration; stop_reason; tool_use_blocks }) => void;
  onToolCall?: (name, input) => void;
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

## Loop invariants

`runAgenticTurn` calls `streamAssistantMessage` in a loop and breaks
when `stop_reason !== "tool_use"`. The assistant turn (including any
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
response + one tool round. When the cap is hit, the function returns
the last assistant message — which still carries
`stop_reason === "tool_use"`, letting callers detect the cap fired
(the REPL prints a warning). Unset means unbounded. Both runners
honor it identically.

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

**Behavioral divergences** (all in `agentic_sdk.ts`):
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
`run(rawInput)` directly.

## Security boundary for `calculator`

The character whitelist regex `^[\d+\-*/().\s]+$` is what makes the
`new Function(...)` evaluator safe — it admits only arithmetic, no
identifiers or calls. Do not relax this regex without replacing the
evaluator with a real parser.
