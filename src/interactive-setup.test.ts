import { describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import { run_interactive_setup, type Interactive_setup_dependencies } from "./interactive-setup.ts";

function create_loaded_config(): Loaded_devtree_config {
  return {
    config: {
      project_name: "web-ui",
      env: { provider: "dotenv", entries: () => [] },
    },
    config_path: "/repo/devtree.config.ts",
    repo_root: "/repo",
    yaml_config: {
      project_path: "/repo/.devtree.yml",
      local_path: "/repo/.devtree.local.yml",
      project: {},
      local: {},
      merged: {},
    },
  };
}

describe("interactive setup", () => {
  test("detects machine defaults and writes YAML configuration after confirmation", async () => {
    const answers = ["dev.example.com", "", "", ""];
    const logs: string[] = [];
    const writes: unknown[] = [];
    const dependencies: Interactive_setup_dependencies = {
      ask: async () => answers.shift() ?? "",
      log: (message) => logs.push(message),
      command_exists: (command) => command === "caddy",
      resolve_tailscale: () => ({
        enabled: true,
        mode: "proxy",
        cli_available: true,
        connected: true,
        host: "markus-mbp.example.ts.net",
        ipv4: "100.101.102.103",
        node_id: "node-123",
        error: null,
      }),
      write_config: (repo_root, values) => {
        writes.push({ repo_root, values });
        return {
          project_path: "/repo/.devtree.yml",
          local_path: "/repo/.devtree.local.yml",
        };
      },
    };

    const result = await run_interactive_setup(create_loaded_config(), dependencies);

    expect(result).toMatchObject({
      configured: true,
      hostname_suffix: "markus-mbp.dev.example.com",
      tailscale_ipv4: "100.101.102.103",
    });
    expect(writes).toEqual([
      {
        repo_root: "/repo",
        values: {
          base_domain: "dev.example.com",
          machine_name: "markus-mbp",
          port: 1355,
        },
      },
    ]);
    expect(logs).toContain(
      "Required wildcard DNS: *.markus-mbp.dev.example.com -> 100.101.102.103",
    );
  });

  test("does not write files when the user cancels", async () => {
    const answers = ["dev.example.com", "alice", "1355", "no"];
    let write_count = 0;
    const dependencies: Interactive_setup_dependencies = {
      ask: async () => answers.shift() ?? "",
      log: () => undefined,
      command_exists: () => true,
      resolve_tailscale: () => ({
        enabled: true,
        mode: "proxy",
        cli_available: true,
        connected: true,
        host: "devbox.example.ts.net",
        ipv4: "100.101.102.103",
        node_id: "node-123",
        error: null,
      }),
      write_config: () => {
        write_count += 1;
        return { project_path: "", local_path: "" };
      },
    };

    await expect(run_interactive_setup(create_loaded_config(), dependencies)).resolves.toEqual({
      configured: false,
    });
    expect(write_count).toBe(0);
  });

  test("reports a missing Tailscale CLI before prompting", async () => {
    let prompt_count = 0;
    const dependencies: Interactive_setup_dependencies = {
      ask: async () => {
        prompt_count += 1;
        return "";
      },
      log: () => undefined,
      command_exists: () => true,
      resolve_tailscale: () => ({
        enabled: true,
        mode: "proxy",
        cli_available: false,
        connected: false,
        host: null,
        ipv4: null,
        node_id: null,
        error: "missing",
      }),
      write_config: () => ({ project_path: "", local_path: "" }),
    };

    await expect(run_interactive_setup(create_loaded_config(), dependencies)).rejects.toThrow(
      "not available on PATH",
    );
    expect(prompt_count).toBe(0);
  });
});
