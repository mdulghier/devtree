import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { ensure_env_file } from "./env-file.ts";
import { create_devtree_instance } from "./instance.ts";
import type { Loaded_devtree_config } from "./config.ts";

function create_loaded_config(repo_root: string): Loaded_devtree_config {
  return {
    config: {
      project_name: "demo-app",
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
  test("passes the canonical public URL to managed environment callbacks", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-env-test-"));
    const loaded_config: Loaded_devtree_config = {
      config: {
        project_name: "web-ui",
        portless: {
          hostname: ({ project_name }) => `${project_name}.developer.dev.example.com`,
        },
        env: {
          provider: "dotenv",
          file_path: ".env.test-managed",
          entries: ({ instance }) => [
            {
              kind: "value",
              key: "APP_URL",
              value: instance.public_url,
            },
          ],
        },
      },
      config_path: `${repo_root}/devtree.config.ts`,
      repo_root,
    };
    const instance = create_devtree_instance(loaded_config);
    const result = ensure_env_file(loaded_config, instance);

    expect(result.managed_env_values.APP_URL).toBe("http://web-ui.developer.dev.example.com:1355");

    rmSync(repo_root, { force: true, recursive: true });
  });

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

  test("removes stale preamble fragments outside the managed block", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-env-test-"));
    const loaded_config = create_loaded_config(repo_root);
    const env_file_path = `${repo_root}/.env.test-managed`;

    writeFileSync(
      env_file_path,
      [
        "# test preamble",
        "# >>> test managed env >>>",
        "DATABASE_URL=postgres://stale",
        "# CUSTOM=",
        "# <<< test managed env <<<",
        "",
        "# test preamble",
        "# Local note that should stay",
        "",
        "# test preamble",
        "",
        "APP_MODE=dev",
      ].join("\n") + "\n",
    );

    const instance = create_devtree_instance(loaded_config);

    ensure_env_file(loaded_config, {
      ...instance,
      env_file_path,
    });

    expect(readFileSync(env_file_path, "utf8")).toBe(
      [
        "# test preamble",
        "# >>> test managed env >>>",
        "DATABASE_URL=postgres://example",
        "# CUSTOM=",
        "# <<< test managed env <<<",
        "",
        "# Local note that should stay",
        "",
        "# test preamble",
        "",
        "APP_MODE=dev",
      ].join("\n") + "\n",
    );

    rmSync(repo_root, { force: true, recursive: true });
  });

  test("replaces a malformed managed block without duplicating the file", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-env-test-"));
    const loaded_config = create_loaded_config(repo_root);
    const env_file_path = `${repo_root}/.env.test-managed`;

    writeFileSync(
      env_file_path,
      [
        "APP_MODE=dev",
        "",
        "# test preamble",
        "# >>> test managed env >>>",
        "DATABASE_URL=postgres://stale",
        "# CUSTOM=",
      ].join("\n") + "\n",
    );

    const instance = create_devtree_instance(loaded_config);

    ensure_env_file(loaded_config, {
      ...instance,
      env_file_path,
    });

    expect(readFileSync(env_file_path, "utf8")).toBe(
      [
        "# test preamble",
        "# >>> test managed env >>>",
        "DATABASE_URL=postgres://example",
        "# CUSTOM=",
        "# <<< test managed env <<<",
        "",
        "APP_MODE=dev",
      ].join("\n") + "\n",
    );

    rmSync(repo_root, { force: true, recursive: true });
  });
});
