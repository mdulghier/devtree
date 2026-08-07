import type {
  Devtree_config,
  Resolved_env_map,
  Routing_hostname_context,
} from "./config.ts";
import {
  CADDY_DEFAULT_ADMIN_URL,
  normalize_caddy_admin_url,
} from "./caddy.ts";

export type Routing_provider_kind = "portless" | "caddy";

export type Resolved_routing = {
  provider_kind: Routing_provider_kind;
  enabled: boolean;
  hostname_resolver: ((context: Routing_hostname_context) => string) | null;
  port: number;
  https: boolean;
  bootstrap: "best-effort" | "manual";
  caddy_admin_url: string | null;
};

function resolve_port(value: number | string, source: string) {
  const port = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} "${value}" must be an integer from 1 to 65535.`);
  }

  return port;
}

function resolve_caddy_admin_url(config: Devtree_config) {
  const provider = config.routing?.provider;
  const raw_url = provider?.kind === "caddy" ? provider.admin_url : undefined;
  return normalize_caddy_admin_url(raw_url?.trim() || CADDY_DEFAULT_ADMIN_URL);
}

export function resolve_routing(
  config: Devtree_config,
  env: Resolved_env_map = process.env,
): Resolved_routing {
  const provider_kind = config.routing?.provider?.kind ?? "portless";
  const uses_routing_config = config.routing !== undefined;
  const configured_port = uses_routing_config
    ? config.routing?.port
    : config.portless?.port;
  const raw_port =
    configured_port ??
    (uses_routing_config ? undefined : env.PORTLESS_PORT?.trim()) ??
    1355;
  const port = resolve_port(raw_port, "Routing port");
  const https_preference = uses_routing_config
    ? (config.routing?.https ?? false)
    : (config.portless?.https ?? "inherit");
  const https =
    https_preference === "inherit"
      ? env.PORTLESS_HTTPS?.trim() === "1"
      : https_preference;

  if (provider_kind === "caddy" && https) {
    throw new Error(
      "Caddy routing currently supports plain HTTP only. Set routing.https to false.",
    );
  }

  const provider = config.routing?.provider;

  return {
    provider_kind,
    enabled:
      provider_kind === "caddy" ||
      (config.portless?.enabled !== false && env.PORTLESS !== "0"),
    hostname_resolver: uses_routing_config
      ? (config.routing?.hostname ?? null)
      : (config.portless?.hostname ?? null),
    port,
    https,
    bootstrap:
      provider?.kind === "caddy"
        ? (provider.bootstrap ?? "best-effort")
        : (config.portless?.bootstrap ?? "best-effort"),
    caddy_admin_url:
      provider_kind === "caddy" ? resolve_caddy_admin_url(config) : null,
  };
}

export function has_configured_routing_hostname(config: Devtree_config) {
  return config.routing
    ? config.routing.hostname !== undefined
    : config.portless?.hostname !== undefined;
}
