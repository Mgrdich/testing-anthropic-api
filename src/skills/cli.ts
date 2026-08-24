import type { DieFn } from "@/core/index.ts";
import { Debug, makeCli, parseArgs, runMain } from "@/core/index.ts";
import { generateWithSkill, isSkillId, SKILL_IDS } from "@/skills/index.ts";

const USAGE = `Usage: bun run skills <subcommand> [args]

Subcommands:
  generate --skill pptx|xlsx|docx|pdf [--out DIR] [--model id] [--debug] "<prompt>"
      Run an Anthropic Agent Skill (Messages API container.skills +
      server-side code execution) against "<prompt>" and download every
      generated file into DIR.
      Default --out: ./skills-out. Default --model: project DEFAULT_MODEL.
      The model's narration streams to stdout; each downloaded artifact is
      printed as "saved <path>". --debug emits [debug] traces to stderr.
`;

const cli = makeCli(USAGE);
const die: DieFn = cli.die;
const { getString } = cli;

async function main(argv: readonly string[]) {
  const sub = argv[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  const { positional, flags } = parseArgs(argv.slice(1));

  switch (sub) {
    case "generate": {
      if (flags.debug === true) Debug.get().enable();
      const skillRaw = getString(flags, "skill");
      if (skillRaw === undefined) {
        die(`generate requires --skill ${SKILL_IDS.join("|")}`);
      }
      if (!isSkillId(skillRaw)) {
        die(`--skill must be ${SKILL_IDS.join("|")} (got ${skillRaw})`);
      }
      const prompt = positional[0];
      if (!prompt) die('generate requires a "<prompt>" argument');
      if (positional.length > 1) {
        die("generate takes a single prompt — quote it");
      }
      const outDir = getString(flags, "out") ?? "./skills-out";
      const model = getString(flags, "model");

      const { savedPaths, warnings } = await generateWithSkill({
        skill: skillRaw,
        prompt,
        outDir,
        model,
        onText: (text) => process.stdout.write(text),
      });
      process.stdout.write("\n");
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      if (savedPaths.length === 0) {
        process.stderr.write("no generated files found in the response\n");
      }
      for (const p of savedPaths) process.stdout.write(`saved ${p}\n`);
      return;
    }
    default:
      die(`unknown subcommand: ${sub}`);
  }
}

runMain(main);
