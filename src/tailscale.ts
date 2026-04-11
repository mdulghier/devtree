import type { Devtree_config } from "./config.ts";
import { command_exists, run_command_capture } from "./process.ts";

export type Resolved_tailscale = {
  enabled: boolean;
  cli_available: boolean;
  host: string | null;
  error: string | null;
};

type Tailscale_status = {
  Self?: {
    DNSName?: string | null;
  } | null;
};

export function tailscale_enabled(config: Devtree_config) {
  return config.tailscale?.enabled === true;
}

export function parse_tailscale_host(status_json: string) {
  const parsed_status = JSON.parse(status_json) as Tailscale_status;
  const host = parsed_status.Self?.DNSName?.trim().replace(/\.$/, "");

  return host || null;
}

export function resolve_tailscale(config: Devtree_config): Resolved_tailscale {
  if (!tailscale_enabled(config)) {
    return {
      enabled: false,
      cli_available: false,
      host: null,
      error: null,
    };
  }

  if (!command_exists("tailscale")) {
    return {
      enabled: true,
      cli_available: false,
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
      cli_available: true,
      host: null,
      error:
        status_result.stderr ||
        "tailscale is enabled, but `tailscale status --json` did not return a usable host",
    };
  }

  try {
    const host = parse_tailscale_host(status_result.stdout);

    if (!host) {
      return {
        enabled: true,
        cli_available: true,
        host: null,
        error:
          "tailscale is enabled, but `tailscale status --json` did not report a MagicDNS host",
      };
    }

    return {
      enabled: true,
      cli_available: true,
      host,
      error: null,
    };
  } catch {
    return {
      enabled: true,
      cli_available: true,
      host: null,
      error: "tailscale is enabled, but `tailscale status --json` returned invalid JSON",
    };
  }
}
