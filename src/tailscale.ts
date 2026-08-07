import type { Devtree_config, Tailscale_mode } from "./config.ts";
import { command_exists, run_command_capture } from "./process.ts";

export type Resolved_tailscale_mode = "disabled" | Tailscale_mode;

export type Resolved_tailscale = {
  enabled: boolean;
  mode: Resolved_tailscale_mode;
  cli_available: boolean;
  connected: boolean;
  host: string | null;
  error: string | null;
};

type Tailscale_status = {
  BackendState?: string | null;
  Self?: {
    DNSName?: string | null;
    Online?: boolean | null;
  } | null;
};

export function tailscale_enabled(config: Devtree_config) {
  return config.tailscale?.enabled === true;
}

export function get_tailscale_mode(config: Devtree_config): Resolved_tailscale_mode {
  if (!tailscale_enabled(config)) {
    return "disabled";
  }

  return config.tailscale?.mode ?? "direct";
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

export function resolve_tailscale(config: Devtree_config): Resolved_tailscale {
  const mode = get_tailscale_mode(config);

  if (mode === "disabled") {
    return {
      enabled: false,
      mode,
      cli_available: false,
      connected: false,
      host: null,
      error: null,
    };
  }

  if (!command_exists("tailscale")) {
    return {
      enabled: true,
      mode,
      cli_available: false,
      connected: false,
      host: null,
      error: "tailscale is enabled, but the `tailscale` command is not available on PATH",
    };
  }

  const status_result = run_command_capture("tailscale", ["status", "--json"], {
    allow_failure: true,
  });

  if (status_result.status !== 0) {
    return {
      enabled: true,
      mode,
      cli_available: true,
      connected: false,
      host: null,
      error:
        status_result.stderr ||
        "tailscale is enabled, but `tailscale status --json` did not return a usable host",
    };
  }

  try {
    const host = parse_tailscale_host(status_result.stdout);
    const connected = parse_tailscale_connection(status_result.stdout);

    if (!connected) {
      return {
        enabled: true,
        mode,
        cli_available: true,
        connected: false,
        host: null,
        error: "tailscale is enabled, but the local Tailscale client is not connected",
      };
    }

    if (mode === "direct" && !host) {
      return {
        enabled: true,
        mode,
        cli_available: true,
        connected: true,
        host: null,
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
      error: null,
    };
  } catch {
    return {
      enabled: true,
      mode,
      cli_available: true,
      connected: false,
      host: null,
      error: "tailscale is enabled, but `tailscale status --json` returned invalid JSON",
    };
  }
}
