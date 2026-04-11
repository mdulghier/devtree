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
