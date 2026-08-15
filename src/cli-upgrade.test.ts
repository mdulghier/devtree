import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

describe("devtree upgrade CLI", () => {
  test("inspects config source without importing it", () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-cli-test-"));
    const project_root = resolve(test_root, "project");
    const isolated_home = resolve(test_root, "home");
    const cli_path = resolve(process.cwd(), "src", "cli.ts");
    const tsx_loader_path = createRequire(import.meta.url).resolve("tsx");

    try {
      mkdirSync(project_root, { recursive: true });
      writeFileSync(
        resolve(project_root, "devtree.config.ts"),
        `import "this-package-does-not-exist";

export default {
  project_name: "acme-cloud",
  endpoints: {
    ui: { primary: true, target: { kind: "dev-server" } },
  },
};
`,
      );

      const result = spawnSync(
        process.execPath,
        ["--import", tsx_loader_path, cli_path, "upgrade"],
        {
          cwd: project_root,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: isolated_home,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Nothing to upgrade");
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });
});
