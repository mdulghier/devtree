import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

describe("devtree list CLI", () => {
  test("runs outside a configured Devtree project", () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-list-cli-test-"));
    const isolated_home = resolve(test_root, "home");
    const tsx_path = resolve(process.cwd(), "node_modules", ".bin", "tsx");
    const cli_path = resolve(process.cwd(), "src", "cli.ts");

    try {
      const result = spawnSync(tsx_path, [cli_path, "list", "--json"], {
        cwd: test_root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolated_home,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("[]");
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });
});
