import { describe, expect, test } from "vite-plus/test";

import type { Devtree_config } from "./config.ts";
import {
  get_tailscale_mode,
  parse_tailscale_connection,
  parse_tailscale_host,
  parse_tailscale_ipv4,
  parse_tailscale_node_id,
  resolve_tailscale,
} from "./tailscale.ts";

describe("parse_tailscale_host", () => {
  test("reads the MagicDNS host from tailscale status output", () => {
    expect(
      parse_tailscale_host(JSON.stringify({ Self: { DNSName: "devbox.example.ts.net." } })),
    ).toBe("devbox.example.ts.net");
  });

  test("returns null when the host is missing", () => {
    expect(parse_tailscale_host(JSON.stringify({ Self: {} }))).toBeNull();
  });

  test("detects a connected Tailscale backend without requiring MagicDNS", () => {
    expect(parse_tailscale_connection(JSON.stringify({ BackendState: "Running", Self: {} }))).toBe(
      true,
    );
  });

  test("reads the node identity and IPv4 address from status", () => {
    const status_json = JSON.stringify({
      TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
      Self: { ID: "node-123" },
    });

    expect(parse_tailscale_ipv4(status_json)).toBe("100.101.102.103");
    expect(parse_tailscale_node_id(status_json)).toBe("node-123");
  });

  test("keeps enabled configurations in legacy direct mode by default", () => {
    const config: Devtree_config = {
      project_name: "demo",
      tailscale: { enabled: true },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("direct");
  });

  test("infers proxy mode when Tailscale is enabled with Caddy", () => {
    const config: Devtree_config = {
      project_name: "demo",
      routing: { provider: { kind: "caddy" } },
      tailscale: { enabled: true },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("proxy");
  });

  test("resolves the explicit Portless proxy mode", () => {
    const config: Devtree_config = {
      project_name: "demo",
      tailscale: { enabled: true, mode: "portless-proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("proxy");
  });

  test("resolves the provider-neutral proxy mode", () => {
    const config: Devtree_config = {
      project_name: "demo",
      tailscale: { enabled: true, mode: "proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("proxy");
  });

  test("does not execute commands when Tailscale is disabled", () => {
    const commands: string[] = [];
    const config: Devtree_config = {
      project_name: "demo",
      env: { provider: "dotenv", entries: () => [] },
    };

    const resolved_tailscale = resolve_tailscale(config, {
      command_exists: (command) => {
        commands.push(command);
        return true;
      },
      run_command_capture: (command, args) => {
        commands.push([command, ...args].join(" "));
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(resolved_tailscale.mode).toBe("disabled");
    expect(commands).toEqual([]);
  });

  test("reports a missing Tailscale CLI actionably", () => {
    const config: Devtree_config = {
      project_name: "demo",
      tailscale: { enabled: true, mode: "proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(
      resolve_tailscale(config, {
        command_exists: () => false,
        run_command_capture: () => ({ status: 1, stdout: "", stderr: "" }),
      }),
    ).toMatchObject({
      cli_available: false,
      connected: false,
      error: expect.stringContaining("not available on PATH"),
    });
  });

  test("reports a disconnected tailnet actionably", () => {
    const config: Devtree_config = {
      project_name: "demo",
      tailscale: { enabled: true, mode: "proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(
      resolve_tailscale(config, {
        command_exists: () => true,
        run_command_capture: () => ({
          status: 0,
          stdout: JSON.stringify({ BackendState: "Stopped", Self: { Online: false } }),
          stderr: "",
        }),
      }),
    ).toMatchObject({
      cli_available: true,
      connected: false,
      error: expect.stringContaining("not connected"),
    });
  });
});
