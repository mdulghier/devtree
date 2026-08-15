import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import { create_devtree_instance } from "./instance.ts";

function create_loaded_config(repo_root: string): Loaded_devtree_config {
  return {
    config: {
      project_name: "acme-cloud",
      endpoints: {
        ui: {
          primary: true,
          target: { kind: "dev-server" },
        },
        api: {
          target: ({ instance }) => ({
            kind: "port",
            port: instance.allocate_port("api", 3000),
          }),
        },
      },
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
  test("creates the default session and endpoint URLs", () => {
    const instance = create_devtree_instance(create_loaded_config("/tmp/devtree-main-checkout"));

    expect(instance.project_name).toBe("acme-cloud");
    expect(instance.session_name).toBe("default");
    expect(instance.dependencies.owns).toBe(true);
    expect(instance.public_hostname).toBe("acme-cloud.localhost");
    expect(instance.endpoints.api?.public_hostname).toBe("api.acme-cloud.localhost");
  });

  test("uses an explicit session name in every endpoint hostname", () => {
    const instance = create_devtree_instance(create_loaded_config("/tmp/devtree-named-checkout"), {
      session_name: "billing",
    });

    expect(instance.public_hostname).toBe("billing.acme-cloud.localhost");
    expect(instance.endpoints.api?.public_hostname).toBe("billing.api.acme-cloud.localhost");
  });

  test("uses routing.hostname for every endpoint", () => {
    const loaded_config = create_loaded_config("/tmp/devtree-custom-hostname");

    loaded_config.config.routing = {
      hostname: ({ session_name, endpoint_name, project_name }) =>
        `${session_name}-${endpoint_name}.${project_name}.example.com`,
    };

    const instance = create_devtree_instance(loaded_config, {
      session_name: "billing",
    });

    expect(instance.public_hostname).toBe("billing-ui.acme-cloud.example.com");
    expect(instance.endpoints.api?.public_hostname).toBe("billing-api.acme-cloud.example.com");
  });

  test("derives a linked worktree session and reuses default dependencies", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-feature-123-"));

    try {
      writeFileSync(
        resolve(repo_root, ".git"),
        "gitdir: /tmp/acme-cloud/.git/worktrees/feature-123\n",
      );

      const instance = create_devtree_instance(create_loaded_config(repo_root));

      expect(instance.session_name).toBe("feature-123");
      expect(instance.dependency_owner).toBe("default");
      expect(instance.dependencies.owns).toBe(false);
      expect(instance.public_hostname).toBe("feature-123.acme-cloud.localhost");
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("can give a worktree its own dependency scope", () => {
    const repo_root = mkdtempSync(resolve(tmpdir(), "devtree-isolated-"));

    try {
      writeFileSync(
        resolve(repo_root, ".git"),
        "gitdir: /tmp/acme-cloud/.git/worktrees/isolated\n",
      );

      const instance = create_devtree_instance(create_loaded_config(repo_root), {
        own_dependencies: true,
      });

      expect(instance.dependency_owner).toBe("isolated");
      expect(instance.dependencies.owns).toBe(true);
    } finally {
      rmSync(repo_root, { force: true, recursive: true });
    }
  });

  test("keeps session and dependency allocations separate", () => {
    const loaded_config = create_loaded_config("/tmp/devtree-port-scope");
    const consumer = create_devtree_instance(loaded_config, {
      session_name: "consumer",
      dependency_owner: "default",
    });
    const other_consumer = create_devtree_instance(loaded_config, {
      session_name: "other",
      dependency_owner: "default",
    });

    expect(consumer.dependencies.allocate_port("db", 5400)).toBe(
      other_consumer.dependencies.allocate_port("db", 5400),
    );
    expect(consumer.allocate_port("api", 3000)).not.toBe(other_consumer.allocate_port("api", 3000));
  });
});
