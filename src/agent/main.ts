#!/usr/bin/env bun
import { runAgentCli } from "@/agent/cli.ts";
import { runMain } from "@/core/cli.ts";

runMain(runAgentCli);
