import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { ensure_caddy_process, get_caddy_state_paths } from "./caddy-process.ts";
import type { Logged_command_options } from "./process.ts";

function create_dependencies(options?: {
  ready?: Array<boolean | "unreachable">;
  command_available?: boolean;
  command_result?: { status: number; stdout: string; stderr: string };
  listen_addresses?: string[] | null;
}) {
  const commands: Array<{
    command: string;
    args: string[];
    log_path: string;
    options?: Logged_command_options;
  }> = [];
  const ready = [...(options?.ready ?? [true])];

  return {
    commands,
    dependencies: {
      command_exists: () => options?.command_available ?? true,
      get_caddy_listen_addresses: async () =>
        options?.listen_addresses ?? ["127.0.0.1:1355"],
      is_caddy_ready: async () => {
        const next_ready = ready.shift();

        if (next_ready === undefined || next_ready === "unreachable") {
          throw new Error("not reachable");
        }

        return next_ready;
      },
      run_command_logged: async (
        command: string,
        args: string[],
        log_path: string,
        command_options?: Logged_command_options,
      ) => {
        commands.push({ command, args, log_path, options: command_options });
        return options?.command_result ?? { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("ensure_caddy_process", () => {
  test("does nothing when Devtree's Caddy server is ready", async () => {
    const { commands, dependencies } = create_dependencies({ ready: [true] });

    await ensure_caddy_process({
      admin_url: "http://127.0.0.1:2020",
      public_port: 1355,
      should_start: false,
      dependencies,
    });

    expect(commands).toEqual([]);
  });

  test("starts Caddy with isolated state and the generated config", async () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-caddy-"));
    const { commands, dependencies } = create_dependencies({
      ready: ["unreachable", true],
    });

    await ensure_caddy_process({
      admin_url: "http://127.0.0.1:2020",
      public_port: 1355,
      should_start: true,
      state_root,
      dependencies,
    });

    const paths = get_caddy_state_paths(state_root);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: "caddy",
      args: ["start", "--config", paths.config_path, "--pidfile", paths.pid_path],
      log_path: paths.log_path,
      options: {
        cwd: state_root,
        detached: true,
        env: {
          XDG_CONFIG_HOME: paths.xdg_config_home,
          XDG_DATA_HOME: paths.xdg_data_home,
        },
      },
    });
    expect(existsSync(paths.config_path)).toBe(true);
    expect(readFileSync(paths.config_path, "utf8")).toContain('"127.0.0.1:1355"');

    rmSync(state_root, { force: true, recursive: true });
  });

  test("does not replace an unrelated Caddy configuration", async () => {
    const { commands, dependencies } = create_dependencies({ ready: [false] });

    await expect(
      ensure_caddy_process({
        admin_url: "http://127.0.0.1:2020",
        public_port: 1355,
        should_start: true,
        dependencies,
      }),
    ).rejects.toThrow("does not contain Devtree's server");
    expect(commands).toEqual([]);
  });

  test("rejects a different public port on the shared Caddy process", async () => {
    const { dependencies } = create_dependencies({
      ready: [true],
      listen_addresses: ["127.0.0.1:2468"],
    });

    await expect(
      ensure_caddy_process({
        admin_url: "http://127.0.0.1:2020",
        public_port: 1355,
        should_start: false,
        dependencies,
      }),
    ).rejects.toThrow("must use the same routing.port");
  });

  test("explains how to start Caddy when automatic bootstrap is disabled", async () => {
    const { dependencies } = create_dependencies({ ready: [] });

    await expect(
      ensure_caddy_process({
        admin_url: "http://127.0.0.1:2020",
        public_port: 1355,
        should_start: false,
        dependencies,
      }),
    ).rejects.toThrow("doctor --fix");
  });

  test("explains how to resolve a shared-port conflict", async () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-caddy-conflict-"));
    const { dependencies } = create_dependencies({
      ready: ["unreachable", "unreachable"],
      command_result: {
        status: 1,
        stdout: "",
        stderr: "listen tcp 127.0.0.1:1355: bind: address already in use",
      },
    });

    await expect(
      ensure_caddy_process({
        admin_url: "http://127.0.0.1:2020",
        public_port: 1355,
        should_start: true,
        state_root,
        dependencies,
      }),
    ).rejects.toThrow("portless proxy stop -p 1355");

    rmSync(state_root, { force: true, recursive: true });
  });
});
