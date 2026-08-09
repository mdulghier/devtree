import { isIP } from "node:net";

import type { Devtree_config, Tailscale_mode } from "./config.ts";
import {
  command_exists,
  run_command_capture,
  type Command_result,
} from "./process.ts";

export type Resolved_tailscale_mode = "disabled" | "direct" | "proxy";

export type Resolved_tailscale = {
  enabled: boolean;
  mode: Resolved_tailscale_mode;
  cli_available: boolean;
  connected: boolean;
  host: string | null;
  ipv4: string | null;
  node_id: string | null;
  error: string | null;
};

type Tailscale_status = {
  BackendState?: string | null;
  Self?: {
    ID?: string | null;
    DNSName?: string | null;
    Online?: boolean | null;
    TailscaleIPs?: string[] | null;
  } | null;
  TailscaleIPs?: string[] | null;
};

export type Tailscale_dependencies = {
  command_exists: (command: string) => boolean;
  run_command_capture: (command: string, args: string[]) => Command_result;
};

const default_dependencies: Tailscale_dependencies = {
  command_exists,
  run_command_capture: (command, args) =>
    run_command_capture(command, args, { allow_failure: true }),
};

export function tailscale_enabled(config: Devtree_config) {
  return config.tailscale?.enabled === true;
}

export function get_tailscale_mode(config: Devtree_config): Resolved_tailscale_mode {
  if (!tailscale_enabled(config)) {
    return "disabled";
  }

  const configured_mode: Tailscale_mode =
    config.tailscale?.mode ??
    (config.routing?.provider?.kind === "caddy" ? "proxy" : "direct");

  return configured_mode === "portless-proxy" ? "proxy" : configured_mode;
}

export function parse_tailscale_host(status_json: string) {
  const parsed_status = JSON.parse(status_json) as Tailscale_status;
  const host = parsed_status.Self?.DNSName?.trim().replace(/\.$/, "");

  return host || null;
}

export function parse_tailscale_connection(status_json: string) {
  const parsed_status = JSON.parse(status_json) as Tailscale_status;

  if (parsed_status.BackendState) {
    return parsed_status.BackendState.toLowerCase() === "running";
  }

  return Boolean(parsed_status.Self) && parsed_status.Self?.Online !== false;
}

export function parse_tailscale_ipv4(status_json: string) {
  const parsed_status = JSON.parse(status_json) as Tailscale_status;

  return (
    (parsed_status.TailscaleIPs ?? parsed_status.Self?.TailscaleIPs ?? []).find(
      (ip_address) => isIP(ip_address) === 4,
    ) ?? null
  );
}

export function parse_tailscale_node_id(status_json: string) {
  const parsed_status = JSON.parse(status_json) as Tailscale_status;
  return parsed_status.Self?.ID?.trim() || null;
}

export function resolve_tailscale(
  config: Devtree_config,
  dependencies: Tailscale_dependencies = default_dependencies,
): Resolved_tailscale {
  const mode = get_tailscale_mode(config);

  if (mode === "disabled") {
    return {
      enabled: false,
      mode,
      cli_available: false,
      connected: false,
      host: null,
      ipv4: null,
      node_id: null,
      error: null,
    };
  }

  if (!dependencies.command_exists("tailscale")) {
    return {
      enabled: true,
      mode,
      cli_available: false,
      connected: false,
      host: null,
      ipv4: null,
      node_id: null,
      error:
        "tailscale is enabled, but the `tailscale` command is not available on PATH. Install Tailscale, sign in, and try again",
    };
  }

  const status_result = dependencies.run_command_capture("tailscale", [
    "status",
    "--json",
  ]);

  if (status_result.status !== 0) {
    return {
      enabled: true,
      mode,
      cli_available: true,
      connected: false,
      host: null,
      ipv4: null,
      node_id: null,
      error:
        status_result.stderr ||
        "tailscale is enabled, but `tailscale status --json` failed. Make sure Tailscale is running and signed in",
    };
  }

  try {
    const host = parse_tailscale_host(status_result.stdout);
    const connected = parse_tailscale_connection(status_result.stdout);
    const ipv4 = parse_tailscale_ipv4(status_result.stdout);
    const node_id = parse_tailscale_node_id(status_result.stdout);

    if (!connected) {
      return {
        enabled: true,
        mode,
        cli_available: true,
        connected: false,
        host: null,
        ipv4: null,
        node_id: null,
        error:
          "tailscale is enabled, but the local Tailscale client is not connected. Run `tailscale status`, sign in if necessary, and try again",
      };
    }

    if (mode === "direct" && !host) {
      return {
        enabled: true,
        mode,
        cli_available: true,
        connected: true,
        host: null,
        ipv4,
        node_id,
        error:
          "tailscale is enabled, but `tailscale status --json` did not report a MagicDNS host",
      };
    }

    return {
      enabled: true,
      mode,
      cli_available: true,
      connected: true,
      host,
      ipv4,
      node_id,
      error: null,
    };
  } catch {
    return {
      enabled: true,
      mode,
      cli_available: true,
      connected: false,
      host: null,
      ipv4: null,
      node_id: null,
      error: "tailscale is enabled, but `tailscale status --json` returned invalid JSON",
    };
  }
}
