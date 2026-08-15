import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import { format_routing_info_lines } from "./info.ts";
import { create_devtree_instance } from "./instance.ts";
import { get_persisted_active_tailscale_routing, read_routing_state } from "./routing-state.ts";
import type { Command_result } from "./process.ts";
import type { Resolved_tailscale } from "./tailscale.ts";
import {
  ensure_tailscale_serve,
  remove_owned_tailscale_serve,
  resolve_tailscale_serve_port,
  type Tailscale_serve_dependencies,
} from "./tailscale-serve.ts";

type Serve_config = {
  TCP?: Record<string, Record<string, unknown>>;
};

const temporary_directories: string[] = [];

function create_temporary_directory(prefix: string) {
  const temporary_directory = mkdtempSync(resolve(tmpdir(), prefix));

  temporary_directories.push(temporary_directory);
  return temporary_directory;
}

function create_instance(repo_root: string, session_name?: string) {
  const loaded_config: Loaded_devtree_config = {
    config: {
      project_name: "web-ui",
      routing: {
        provider: { kind: "caddy" },
        hostname: ({ project_name }) => `${project_name}.alice.dev.example.com`,
        port: 1355,
      },
      tailscale: {
        enabled: true,
        mode: "proxy",
      },
      env: {
        provider: "dotenv",
        entries: () => [],
      },
    },
    config_path: resolve(repo_root, "devtree.config.ts"),
    repo_root,
  };

  return create_devtree_instance(loaded_config, { session_name });
}

function create_tailscale(): Resolved_tailscale {
  return {
    enabled: true,
    mode: "proxy",
    cli_available: true,
    connected: true,
    host: "devbox.example.ts.net",
    ipv4: "100.101.102.103",
    node_id: "node-123",
    error: null,
  };
}

function create_dependencies(initial_config: Serve_config = {}) {
  const commands: Array<{ command: string; args: string[] }> = [];
  const serve_config = structuredClone(initial_config);
  const dependencies: Tailscale_serve_dependencies = {
    command_exists: () => true,
    run_command_capture(command, args): Command_result {
      commands.push({ command, args });

      if (args.join(" ") === "serve status --json") {
        return {
          status: 0,
          stdout: JSON.stringify(serve_config),
          stderr: "",
        };
      }

      const tcp_flag = args.find((arg) => arg.startsWith("--tcp="));
      const serve_port = tcp_flag?.slice("--tcp=".length);

      if (command !== "tailscale" || !serve_port) {
        return { status: 1, stdout: "", stderr: "unexpected command" };
      }

      serve_config.TCP ??= {};

      if (args.at(-1) === "off") {
        delete serve_config.TCP[serve_port];
      } else {
        const target = args.at(-1)?.replace(/^tcp:\/\//u, "");

        serve_config.TCP[serve_port] = { TCPForward: target };
      }

      return { status: 0, stdout: "", stderr: "" };
    },
  };

  return { commands, dependencies, serve_config };
}

function get_mutating_commands(commands: Array<{ command: string; args: string[] }>) {
  return commands.filter(({ args }) => args[1] !== "status");
}

afterEach(() => {
  for (const temporary_directory of temporary_directories.splice(0)) {
    rmSync(temporary_directory, { force: true, recursive: true });
  }
});

describe("Tailscale Serve lifecycle", () => {
  test("defaults the tailnet port to the shared routing port", () => {
    expect(resolve_tailscale_serve_port(undefined, 1355)).toBe(1355);
    expect(resolve_tailscale_serve_port(2468, 1355)).toBe(2468);
    expect(() => resolve_tailscale_serve_port(70_000, 1355)).toThrow("tailscale.serve_port");
  });

  test("configures a first-time TCP Serve mapping and records ownership", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies } = create_dependencies();
    const instance = create_instance("/tmp/devtree-tailscale-first");
    const active_routing = ensure_tailscale_serve({
      instance,
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    });

    expect(get_mutating_commands(commands)).toEqual([
      {
        command: "tailscale",
        args: ["serve", "--tcp=1355", "--bg", "--yes", "tcp://localhost:1355"],
      },
    ]);
    expect(active_routing).toMatchObject({
      tailscale_url: "http://web-ui.alice.dev.example.com:1355",
      mapping_owned: true,
    });
    expect(read_routing_state(state_path).tailscale_mappings["node-123:1355"]).toMatchObject({
      target: "localhost:1355",
      owned: true,
      consumer_instance_ids: [instance.instance_id],
    });
  });

  test("repeated setup is idempotent", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies } = create_dependencies();
    const instance = create_instance("/tmp/devtree-tailscale-idempotent");
    const options = {
      instance,
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    };

    ensure_tailscale_serve(options);
    ensure_tailscale_serve(options);

    expect(get_mutating_commands(commands)).toHaveLength(1);
  });

  test("preserves unrelated Serve routes", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { dependencies, serve_config } = create_dependencies({
      TCP: {
        "8443": { HTTPS: true },
      },
    });

    ensure_tailscale_serve({
      instance: create_instance("/tmp/devtree-tailscale-preserve"),
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    });

    expect(serve_config.TCP?.["8443"]).toEqual({ HTTPS: true });
    expect(serve_config.TCP?.["1355"]).toEqual({
      TCPForward: "localhost:1355",
    });
  });

  test("rejects a conflicting mapping without changing it", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies, serve_config } = create_dependencies({
      TCP: {
        "1355": { TCPForward: "localhost:9999" },
        "8443": { HTTPS: true },
      },
    });

    expect(() =>
      ensure_tailscale_serve({
        instance: create_instance("/tmp/devtree-tailscale-conflict"),
        tailscale: create_tailscale(),
        routing_port: 1355,
        serve_port: 1355,
        state_path,
        dependencies,
      }),
    ).toThrow("conflicts with Devtree");
    expect(get_mutating_commands(commands)).toEqual([]);
    expect(serve_config.TCP).toEqual({
      "1355": { TCPForward: "localhost:9999" },
      "8443": { HTTPS: true },
    });
  });

  test("shares one mapping across multiple worktrees", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies } = create_dependencies();
    const first_instance = create_instance("/tmp/devtree-tailscale-worktree-one", "worktree-one");
    const second_instance = create_instance("/tmp/devtree-tailscale-worktree-two", "worktree-two");

    for (const instance of [first_instance, second_instance]) {
      ensure_tailscale_serve({
        instance,
        tailscale: create_tailscale(),
        routing_port: 1355,
        serve_port: 1355,
        state_path,
        dependencies,
      });
    }

    expect(get_mutating_commands(commands)).toHaveLength(1);
    expect(
      read_routing_state(state_path).tailscale_mappings["node-123:1355"]?.consumer_instance_ids,
    ).toEqual([first_instance.instance_id, second_instance.instance_id].sort());
  });

  test("fresh URL discovery uses persisted startup state", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { dependencies } = create_dependencies();
    const instance = create_instance("/tmp/devtree-tailscale-info");
    const startup_routing = ensure_tailscale_serve({
      instance,
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 2468,
      state_path,
      dependencies,
    });

    const fresh_instance = create_instance("/tmp/devtree-tailscale-info");
    const discovered_routing = get_persisted_active_tailscale_routing(fresh_instance, state_path);

    expect(discovered_routing?.tailscale_url).toBe(startup_routing.tailscale_url);
    expect(discovered_routing?.tailscale_url).toBe("http://web-ui.alice.dev.example.com:2468");
    expect(
      format_routing_info_lines({
        instance: fresh_instance,
        tailscale_mode: "proxy",
        active_tailscale_routing: discovered_routing,
        configured_tailscale_port: 2468,
      }),
    ).toContain("Tailscale application URL: http://web-ui.alice.dev.example.com:2468");
  });

  test("cleanup removes only the Devtree-owned port", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies, serve_config } = create_dependencies({
      TCP: {
        "8443": { HTTPS: true },
      },
    });
    const instance = create_instance("/tmp/devtree-tailscale-cleanup");
    const options = {
      instance,
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    };

    ensure_tailscale_serve(options);
    remove_owned_tailscale_serve(options);

    expect(serve_config.TCP).toEqual({ "8443": { HTTPS: true } });
    expect(get_mutating_commands(commands).at(-1)?.args).toEqual([
      "serve",
      "--tcp=1355",
      "--yes",
      "off",
    ]);
    expect(read_routing_state(state_path).tailscale_mappings["node-123:1355"]).toBeUndefined();
  });

  test("does not remove an identical externally managed mapping", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies } = create_dependencies({
      TCP: {
        "1355": { TCPForward: "localhost:1355" },
      },
    });
    const instance = create_instance("/tmp/devtree-tailscale-external");
    const options = {
      instance,
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    };

    expect(ensure_tailscale_serve(options).mapping_owned).toBe(false);
    expect(() => remove_owned_tailscale_serve(options)).toThrow("cannot prove ownership");
    expect(get_mutating_commands(commands)).toEqual([]);
  });

  test("accepts an equivalent loopback target without overwriting it", () => {
    const state_root = create_temporary_directory("devtree-state-");
    const state_path = resolve(state_root, "routing-state.json");
    const { commands, dependencies } = create_dependencies({
      TCP: {
        "1355": { TCPForward: "127.0.0.1:1355" },
      },
    });

    const active_routing = ensure_tailscale_serve({
      instance: create_instance("/tmp/devtree-tailscale-loopback"),
      tailscale: create_tailscale(),
      routing_port: 1355,
      serve_port: 1355,
      state_path,
      dependencies,
    });

    expect(active_routing.mapping_owned).toBe(false);
    expect(get_mutating_commands(commands)).toEqual([]);
  });
});
