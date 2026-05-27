#!/usr/bin/env bun
import { runCli } from "@/cli/index.ts";
import { errMsg } from "@/core/index.ts";

runCli().catch((err) => {
  process.stderr.write(`error: ${errMsg(err)}\n`);
  process.exit(1);
});
