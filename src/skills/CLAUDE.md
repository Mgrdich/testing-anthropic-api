# `src/skills/`

Agent Skills demo. CLI entry is `src/skills/cli.ts`, exposed as
`bun run skills`. Public API is re-exported from `src/skills/index.ts`.

This is the **Messages API** skills surface — `container.skills` plus the
server-side code-execution tool — not Managed Agents: no agents,
sessions, or environments are involved. Claude runs an Anthropic-managed
document skill (pptx/xlsx/docx/pdf) inside a server-side container, and
the files it writes there come back as Files-API ids that this module
downloads. It is also the only place in the repo that touches the Files
API.

It is a standalone sub-CLI rather than a flag on `bun run dev` because it
doesn't fit the conversational model: dual beta headers, a container, a
16k token budget, and filesystem side effects on every run.

## Layout

```
src/skills/
├── generate.ts   generateWithSkill() — the whole feature
├── cli.ts        `bun run skills` subcommand dispatcher (entry, not exported)
└── index.ts      module barrel
```

## `bun run skills generate`

```
bun run skills generate --skill pptx|xlsx|docx|pdf [--out DIR] [--model id] [--debug] "<prompt>"
```

| Flag      | Type                            | Default          | Effect                                                          |
|-----------|---------------------------------|------------------|-----------------------------------------------------------------|
| `--skill` | `pptx` \| `xlsx` \| `docx` \| `pdf` | *(required)*     | Anthropic-managed skill id, validated at parse time via `isSkillId`. |
| `--out`   | dir path                        | `./skills-out`   | Where downloaded artifacts are written (created if missing; gitignored). |
| `--model` | model id                        | `DEFAULT_MODEL`  | Model that drives the skill.                                    |
| `--debug` | bool                            | off              | Enables the `Debug` singleton (`[debug]` traces on stderr).      |

Exactly one quoted positional prompt; a second positional is an error
("quote it"). Parsing uses the shared `@/core/cli.ts` sub-CLI helpers
(`makeCli` / `parseArgs` / `runMain`), same as eval and rag.

Output: the model's narration streams to **stdout** as it arrives, then
one `saved <path>` line per downloaded artifact. Warnings go to stderr,
and a run that produced no files says so on stderr (exit code stays 0 —
an empty run is not a crash).

## `generateWithSkill(opts)`

One-shot: `client.beta.messages.stream(...)` → `finalMessage()` → walk
the content for generated-file ids → download each via the Files API.
Returns `{ savedPaths, warnings, stopReason }` — the CLI does all the
printing, the library returns data (the `core/` no-terminal-I/O rule
applies here too; only the `onText` callback emits, and the caller
supplies it).

Request shape, all of it load-bearing:

- **Two betas on every request**: `code-execution-2025-08-25` and
  `skills-2025-10-02`. Both, or the call fails.
- **`container: { skills: [{ type: "anthropic", skill_id, version: "latest" }] }`**
  — the skill itself.
- **`tools: [{ type: "code_execution_20260521", name: "code_execution" }]`**
  — the current tool variant. The installed SDK's `BetaToolUnion` stops
  at `code_execution_20260120`, so the literal is cast once through
  `unknown`: the typings lag the API, the wire shape is unchanged. Bump
  the date string (and drop the cast when the union catches up) rather
  than working around it elsewhere.
- **`max_tokens: 16000`**, local to this module. Skill runs produce long
  tool transcripts, so the project-wide `DEFAULT_MAX_TOKENS` (1024)
  truncates mid-run. `stop_reason === "max_tokens"` still warns that
  artifacts may be incomplete.

## Invariants

- **Never trust server-provided filenames.** Every download is written
  as `path.join(outDir, path.basename(meta.filename))`, and `""` / `.` /
  `..` basenames are warned-and-skipped. Keep any new write path behind
  the same sanitization.
- **Unknown block shapes warn and skip, never throw.** `collectFileIds`
  walks `bash_code_execution_tool_result` blocks defensively
  (`isRecord` guards, no casts to SDK unions) because the container can
  return block types newer than the SDK knows about; error results
  (`bash_code_execution_tool_result_error`) simply carry no files. File
  ids are de-duplicated in response order, which is the order
  `savedPaths` preserves.
- **Skill ids are a literal union.** `SKILL_IDS` / `SkillId` /
  `isSkillId` in `generate.ts` are the single source of truth, validated
  at parse time (the `--tools` / `--mcp` convention). Adding a skill
  means adding it there and to the usage block — nothing else.
- **No API key handling here** — `AnthropicClient.get()`, like every
  other module.
- `skills-out/` is gitignored; generated artifacts are never checked in.
