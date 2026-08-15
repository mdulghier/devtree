import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  list_registered_compose_projects,
  list_registered_dependency_owners,
  register_compose_project,
  unregister_compose_project,
} from "./registry.ts";

describe("dependency stack registry", () => {
  test("groups Compose projects by project and dependency owner", () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-projects-test-"));

    try {
      register_compose_project(
        {
          project_name: "acme-cloud",
          dependency_owner: "default",
          dependency_name: "services",
          compose_project: "acme-cloud-default-services",
          worktree_path: "/repo",
        },
        state_root,
      );
      register_compose_project(
        {
          project_name: "acme-cloud",
          dependency_owner: "reporting",
          dependency_name: "services",
          compose_project: "acme-cloud-reporting-services",
          worktree_path: "/repo-reporting",
        },
        state_root,
      );
      register_compose_project(
        {
          project_name: "other-project",
          dependency_owner: "default",
          dependency_name: "services",
          compose_project: "other-project-default-services",
          worktree_path: "/other",
        },
        state_root,
      );

      expect(list_registered_dependency_owners("acme-cloud", state_root)).toEqual([
        "default",
        "reporting",
      ]);
      expect(list_registered_compose_projects("acme-cloud", "reporting", state_root)).toHaveLength(
        1,
      );

      unregister_compose_project("acme-cloud", "acme-cloud-reporting-services", state_root);
      expect(list_registered_dependency_owners("acme-cloud", state_root)).toEqual(["default"]);
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });
});
