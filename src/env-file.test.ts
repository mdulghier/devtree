import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { ensure_env_file } from "./env-file.ts";
import { create_devtree_instance } from "./instance.ts";
import type { Loaded_devtree_config } from "./config.ts";

function create_loaded_config(repo_root: string): Loaded_devtree_config {
  return {
    config: {
      app_name: "target-ascent",
      namespace: "target-ascent",
      env: {
        provider: "dotenv",
        managed_block_id: "test managed env",
        preamble: ["# test preamble"],
        entries: ({ existing_env_values }) => [
          {
            kind: "value",
            key: "DATABASE_URL",
            value: "postgres://example",
          },
          existing_env_values.CUSTOM
            ? { kind: "value", key: "CUSTOM", value: existing_env_values.CUSTOM }
            : { kind: "comment", text: "# CUSTOM=" },
        ],
      },
    },
    config_path: `${repo_root}/devtree.config.ts`,
    repo_root,
  };
}

describe("ensure_env_file", () => {
  test("writes managed env values", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-env-test-"));
    const loaded_config = create_loaded_config(repo_root);
    const instance = create_devtree_instance(loaded_config);
    const result = ensure_env_file(loaded_config, {
      ...instance,
      env_file_path: `${repo_root}/.env.test-managed`,
    });

    expect(result.managed_env_values.DATABASE_URL).toBe("postgres://example");
    expect(result.effective_env_values.DATABASE_URL).toBe("postgres://example");

    rmSync(repo_root, { force: true, recursive: true });
  });
});
