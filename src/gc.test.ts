import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { classify_projects } from "./gc.ts";

describe("classify_projects", () => {
  test("separates active, orphaned, and unknown projects", () => {
    const active_worktree_path = mkdtempSync(resolve(tmpdir(), "devtree-active-worktree-"));
    const classified_projects = classify_projects(
      [
        {
          project_name: "active-project",
          worktree_path: active_worktree_path,
          registry_namespace: "target-ascent",
          containers: [],
          networks: [],
          volumes: [],
          sources: new Set(["container"]),
        },
        {
          project_name: "orphan-project",
          worktree_path: "/tmp/orphan-project",
          registry_namespace: "target-ascent",
          containers: [],
          networks: [],
          volumes: [],
          sources: new Set(["container"]),
        },
        {
          project_name: "unknown-project",
          worktree_path: null,
          registry_namespace: "target-ascent",
          containers: [],
          networks: [],
          volumes: [],
          sources: new Set(["container"]),
        },
      ],
      new Set([active_worktree_path]),
    );

    expect(classified_projects.active_projects).toHaveLength(1);
    expect(classified_projects.orphan_projects).toHaveLength(1);
    expect(classified_projects.unknown_projects).toHaveLength(1);

    rmSync(active_worktree_path, { force: true, recursive: true });
  });
});
