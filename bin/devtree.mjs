#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bin_dir = dirname(fileURLToPath(import.meta.url));
const package_dir = dirname(bin_dir);
const dist_cli_path = resolve(package_dir, "dist", "cli.js");
const src_cli_path = resolve(package_dir, "src", "cli.ts");
const args = existsSync(dist_cli_path)
  ? [dist_cli_path, ...process.argv.slice(2)]
  : ["--import", "tsx", src_cli_path, ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { env: process.env, stdio: "inherit" });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
