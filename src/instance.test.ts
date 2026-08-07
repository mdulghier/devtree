import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { create_devtree_instance } from "./instance.ts";
import type { Loaded_devtree_config } from "./config.ts";

function create_loaded_config(repo_root: string): Loaded_devtree_config {
  return {
    config: {
      app_name: "demo-app",
      namespace: "demo-app",
      env: {
        provider: "dotenv",
        entries: () => [],
      },
    },
    config_path: `${repo_root}/devtree.config.ts`,
    repo_root,
  };
}

describe("create_devtree_instance", () => {
  test("keeps the legacy main-checkout public URL", () => {
    const instance = create_devtree_instance(create_loaded_config("/tmp/devtree-main-checkout"));

    expect(instance.public_hostname).toBe("demo-app.localhost");
    expect(instance.public_url).toBe("http://demo-app.localhost:1355");
  });

  test("uses the configured canonical hostname as the URL source of truth", () => {
    const loaded_config = create_loaded_config("/tmp/devtree-canonical-checkout");

    loaded_config.config.portless = {
      hostname: ({ app_name }) => `${app_name}.developer.dev.example.com`,
      port: 1355,
      https: false,
    };

    const instance = create_devtree_instance(loaded_config);

    expect(instance.public_hostname).toBe("demo-app.developer.dev.example.com");
    expect(instance.public_url).toBe("http://demo-app.developer.dev.example.com:1355");
  });

  test("uses routing.hostname as the Caddy route and URL source of truth", () => {
    const loaded_config = create_loaded_config("/tmp/devtree-caddy-checkout");

    loaded_config.config.routing = {
      provider: { kind: "caddy" },
      hostname: ({ app_name }) => `${app_name}.alice.dev.example.com`,
      port: 1355,
      https: false,
    };

    const instance = create_devtree_instance(loaded_config);

    expect(instance.routing_provider).toBe("caddy");
    expect(instance.routing_enabled).toBe(true);
    expect(instance.portless_enabled).toBe(false);
    expect(instance.public_hostname).toBe("demo-app.alice.dev.example.com");
    expect(instance.public_url).toBe("http://demo-app.alice.dev.example.com:1355");
  });

  test("uses localhost for new routing config without a custom hostname", () => {
    const loaded_config = create_loaded_config("/tmp/devtree-caddy-localhost");
    const previous_tld = process.env.PORTLESS_TLD;

    loaded_config.config.routing = {
      provider: { kind: "caddy" },
    };
    process.env.PORTLESS_TLD = "legacy.example.com";

    try {
      const instance = create_devtree_instance(loaded_config);

      expect(instance.public_hostname).toBe("demo-app.localhost");
    } finally {
      if (previous_tld === undefined) {
        delete process.env.PORTLESS_TLD;
      } else {
        process.env.PORTLESS_TLD = previous_tld;
      }
    }
  });

  test("keeps the legacy worktree URL shape", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-feature-123-"));
    const loaded_config = create_loaded_config(repo_root);

    writeFileSync(
      resolve(repo_root, ".git"),
      "gitdir: /tmp/demo-app/.git/worktrees/feature-123\n",
    );

    const instance = create_devtree_instance(loaded_config);

    expect(instance.public_hostname).toBe("feature-123.demo-app.localhost");
    expect(instance.public_url).toBe("http://feature-123.demo-app.localhost:1355");

    rmSync(repo_root, { force: true, recursive: true });
  });

  test("detects a worktree when the Devtree project is inside the Git worktree", () => {
    const git_root = mkdtempSync(resolve(tmpdir(), "devtree-nested-example-"));
    const repo_root = resolve(git_root, "examples", "simple-portless");

    mkdirSync(repo_root, { recursive: true });
    writeFileSync(
      resolve(git_root, ".git"),
      "gitdir: /tmp/demo-app/.git/worktrees/feature-123\n",
    );

    const instance = create_devtree_instance(create_loaded_config(repo_root));

    expect(instance.worktree_slug).toBe("feature-123");
    expect(instance.public_hostname).toBe("feature-123.demo-app.localhost");

    rmSync(git_root, { force: true, recursive: true });
  });

  test("passes a flattened worktree identity to the canonical hostname callback", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-feature-123-"));
    const loaded_config = create_loaded_config(repo_root);

    loaded_config.config.portless = {
      hostname: ({ app_name, worktree_slug }) => {
        const route_name = worktree_slug ? `${worktree_slug}--${app_name}` : app_name;

        return `${route_name}.developer.dev.example.com`;
      },
    };
    writeFileSync(
      resolve(repo_root, ".git"),
      "gitdir: /tmp/demo-app/.git/worktrees/feature-123\n",
    );

    const instance = create_devtree_instance(loaded_config);

    expect(instance.public_hostname).toBe(
      "feature-123--demo-app.developer.dev.example.com",
    );

    rmSync(repo_root, { force: true, recursive: true });
  });

  test("creates deterministic instance ids and scoped names", () => {
    const first_instance = create_devtree_instance(create_loaded_config("/tmp/worktree-one"));
    const second_instance = create_devtree_instance(create_loaded_config("/tmp/worktree-one"));
    const third_instance = create_devtree_instance(create_loaded_config("/tmp/worktree-two"));

    expect(first_instance.instance_id).toBe(second_instance.instance_id);
    expect(first_instance.scoped_name).toBe(second_instance.scoped_name);
    expect(first_instance.instance_id).not.toBe(third_instance.instance_id);
  });

  test("allocates stable ports per name", () => {
    const instance = create_devtree_instance(create_loaded_config("/tmp/worktree-one"));

    expect(instance.allocate_port("db", 5600, 1000)).toBe(instance.allocate_port("db", 5600, 1000));
    expect(instance.allocate_port("db", 5600, 1000)).not.toBe(
      instance.allocate_port("redis", 5600, 1000),
    );
  });
});
