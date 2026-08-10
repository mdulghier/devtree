import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { load_devtree_config, type Devtree_config } from "./config.ts";
import {
  apply_devtree_yaml_config,
  load_devtree_yaml_config,
  parse_devtree_yaml_config,
} from "./yaml-config.ts";
import { write_interactive_yaml_setup } from "./yaml-config-writer.ts";
import { resolve_devtree_local_config_path } from "./yaml-config-paths.ts";

function create_base_config(): Devtree_config {
  return {
    app_name: "web-ui",
    env: { provider: "dotenv", entries: () => [] },
  };
}

function run_git(repo_root: string, args: string[]) {
  const result = spawnSync("git", ["-C", repo_root, ...args], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe("Devtree YAML configuration", () => {
  test("merges committed and local routing without environment variables", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-yaml-test-"));

    try {
      writeFileSync(
        resolve(repo_root, ".devtree.yml"),
        [
          "version: 1",
          "routing:",
          "  provider: caddy",
          "  base_domain: dev.example.com",
          "  port: 2468",
          "tailscale:",
          "  enabled: true",
          "",
        ].join("\n"),
      );
      writeFileSync(
        resolve(repo_root, ".devtree.local.yml"),
        ["version: 1", "routing:", "  machine_name: alice", ""].join("\n"),
      );

      const yaml_config = load_devtree_yaml_config(repo_root);
      const config = apply_devtree_yaml_config(
        create_base_config(),
        yaml_config.merged,
      );

      expect(config.routing?.provider).toEqual({ kind: "caddy" });
      expect(config.routing?.port).toBe(2468);
      expect(config.tailscale?.enabled).toBe(true);
      expect(
        config.routing?.hostname?.({
          app_name: "web-ui",
          worktree_slug: "feature-123",
        }),
      ).toBe("feature-123--web-ui.alice.dev.example.com");
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("loads YAML overlays through the normal Devtree config loader", async () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-yaml-load-test-"));

    try {
      writeFileSync(
        resolve(repo_root, "devtree.config.ts"),
        `export default {
  app_name: "web-ui",
  env: { provider: "dotenv", entries: () => [] },
};
`,
      );
      writeFileSync(
        resolve(repo_root, ".devtree.yml"),
        "routing:\n  provider: caddy\n  base_domain: dev.example.com\ntailscale:\n  enabled: true\n",
      );
      writeFileSync(
        resolve(repo_root, ".devtree.local.yml"),
        "routing:\n  machine_name: alice\n",
      );

      const loaded_config = await load_devtree_config(repo_root);

      expect(loaded_config.config.routing?.provider).toEqual({ kind: "caddy" });
      expect(
        loaded_config.config.routing?.hostname?.({
          app_name: "web-ui",
          worktree_slug: null,
        }),
      ).toBe("web-ui.alice.dev.example.com");
      expect(loaded_config.yaml_config?.local_path).toBe(
        resolve(repo_root, ".devtree.local.yml"),
      );
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("lets the local hostname suffix override the shared naming fields", () => {
    const config = apply_devtree_yaml_config(create_base_config(), {
      routing: {
        base_domain: "dev.example.com",
        machine_name: "alice",
        hostname_suffix: "custom.internal.example",
      },
    });

    expect(
      config.routing?.hostname?.({ app_name: "web-ui", worktree_slug: null }),
    ).toBe("web-ui.custom.internal.example");
  });

  test("supports project registry opt-out with a local override", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-yaml-registry-test-"));

    try {
      writeFileSync(
        resolve(repo_root, ".devtree.yml"),
        "version: 1\nregistry:\n  enabled: false\n",
      );
      writeFileSync(
        resolve(repo_root, ".devtree.local.yml"),
        "version: 1\nregistry:\n  enabled: true\n",
      );

      const yaml_config = load_devtree_yaml_config(repo_root);
      const config = apply_devtree_yaml_config(
        create_base_config(),
        yaml_config.merged,
      );
      const project_config = apply_devtree_yaml_config(
        create_base_config(),
        yaml_config.project,
      );

      expect(yaml_config.project.registry?.enabled).toBe(false);
      expect(yaml_config.local.registry?.enabled).toBe(true);
      expect(project_config.registry?.enabled).toBe(false);
      expect(config.registry?.enabled).toBe(true);
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("rejects invalid registry settings", () => {
    expect(() =>
      parse_devtree_yaml_config(
        "registry:\n  enabled: sometimes\n",
        ".devtree.yml",
      ),
    ).toThrow(".devtree.yml.registry.enabled must be true or false");
  });

  test("rejects unknown keys with the source filename", () => {
    expect(() =>
      parse_devtree_yaml_config(
        "routing:\n  base_domian: dev.example.com\n",
        ".devtree.yml",
      ),
    ).toThrow('.devtree.yml.routing contains unsupported key "base_domian"');
  });

  test("writes both setup files and ignores the local file", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-yaml-write-test-"));

    try {
      writeFileSync(
        resolve(repo_root, ".devtree.yml"),
        "# Keep this comment\nversion: 1\n",
      );

      write_interactive_yaml_setup(repo_root, {
        base_domain: "dev.example.com",
        machine_name: "alice",
        port: 1355,
      });

      const project_text = readFileSync(resolve(repo_root, ".devtree.yml"), "utf8");
      const local_text = readFileSync(
        resolve(repo_root, ".devtree.local.yml"),
        "utf8",
      );

      expect(project_text).toContain("# Keep this comment");
      expect(project_text).toContain("base_domain: dev.example.com");
      expect(project_text).toContain("enabled: true");
      expect(local_text).toContain("machine_name: alice");
      expect(readFileSync(resolve(repo_root, ".gitignore"), "utf8")).toContain(
        ".devtree.local.yml",
      );
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("shares the primary worktree local configuration with linked worktrees", () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-yaml-worktree-test-"));
    const primary_root = resolve(test_root, "primary");
    const linked_root = resolve(test_root, "linked");
    const project_path = join("examples", "app");

    try {
      mkdirSync(primary_root);
      run_git(primary_root, ["init", "--quiet"]);
      run_git(primary_root, ["config", "user.email", "test@example.com"]);
      run_git(primary_root, ["config", "user.name", "Devtree Test"]);
      mkdirSync(resolve(primary_root, project_path), { recursive: true });
      writeFileSync(resolve(primary_root, project_path, "tracked.txt"), "test\n");
      run_git(primary_root, ["add", project_path]);
      run_git(primary_root, ["commit", "--quiet", "-m", "initial"]);
      run_git(primary_root, ["worktree", "add", "--quiet", "-b", "feature", linked_root]);

      const primary_local_path = resolve(
        primary_root,
        project_path,
        ".devtree.local.yml",
      );
      writeFileSync(primary_local_path, "version: 1\n");

      expect(
        resolve_devtree_local_config_path(resolve(linked_root, project_path)),
      ).toBe(
        realpathSync(primary_local_path),
      );
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });
});
