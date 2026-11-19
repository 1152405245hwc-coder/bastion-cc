#!/usr/bin/env node
import { main } from "../clients/cli/src/index.ts";

await main(process.argv.slice(2));
