#!/usr/bin/env bun
import { runCli } from "@/cli/index.ts";

runCli().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
