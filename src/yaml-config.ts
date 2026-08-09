import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import type {
  Devtree_config,
  Routing_hostname_context,
  Routing_provider,
  Tailscale_mode,
} from "./config.ts";
import {
  DEVTREE_PROJECT_CONFIG_FILENAME,
  resolve_devtree_local_config_path,
} from "./yaml-config-paths.ts";

type Yaml_routing_config = {
  provider?: "portless" | "caddy";
  base_domain?: string;
  machine_name?: string;
  hostname_suffix?: string;
  port?: number;
  https?: boolean;
};

type Yaml_tailscale_config = {
  enabled?: boolean;
  mode?: Tailscale_mode;
  serve_port?: number;
};

export type Devtree_yaml_config = {
  version?: 1;
  routing?: Yaml_routing_config;
  tailscale?: Yaml_tailscale_config;
};

export type Loaded_devtree_yaml_config = {
  project_path: string;
  local_path: string;
  project: Devtree_yaml_config;
  local: Devtree_yaml_config;
  merged: Devtree_yaml_config;
};

const top_level_keys = new Set(["version", "routing", "tailscale"]);
const routing_keys = new Set([
  "provider",
  "base_domain",
  "machine_name",
  "hostname_suffix",
  "port",
  "https",
]);
const tailscale_keys = new Set(["enabled", "mode", "serve_port"]);

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert_known_keys(
  value: Record<string, unknown>,
  allowed_keys: Set<string>,
  source: string,
) {
  const unknown_key = Object.keys(value).find((key) => !allowed_keys.has(key));

  if (unknown_key) {
    throw new Error(`${source} contains unsupported key "${unknown_key}".`);
  }
}

function read_optional_string(
  value: Record<string, unknown>,
  key: string,
  source: string,
) {
  const raw_value = value[key];

  if (raw_value === undefined) {
    return undefined;
  }

  if (typeof raw_value !== "string" || !raw_value.trim()) {
    throw new Error(`${source}.${key} must be a non-empty string.`);
  }

  return raw_value.trim().toLowerCase();
}

function read_optional_boolean(
  value: Record<string, unknown>,
  key: string,
  source: string,
) {
  const raw_value = value[key];

  if (raw_value === undefined) {
    return undefined;
  }

  if (typeof raw_value !== "boolean") {
    throw new Error(`${source}.${key} must be true or false.`);
  }

  return raw_value;
}

function read_optional_port(
  value: Record<string, unknown>,
  key: string,
  source: string,
) {
  const raw_value = value[key];

  if (raw_value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(raw_value) || (raw_value as number) < 1 || (raw_value as number) > 65535) {
    throw new Error(`${source}.${key} must be an integer from 1 to 65535.`);
  }

  return raw_value as number;
}

function parse_routing_config(value: unknown, source: string): Yaml_routing_config | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!is_record(value)) {
    throw new Error(`${source} must be a mapping.`);
  }

  assert_known_keys(value, routing_keys, source);

  const provider = read_optional_string(value, "provider", source);

  if (provider !== undefined && provider !== "portless" && provider !== "caddy") {
    throw new Error(`${source}.provider must be "portless" or "caddy".`);
  }

  return {
    provider,
    base_domain: read_optional_string(value, "base_domain", source),
    machine_name: read_optional_string(value, "machine_name", source),
    hostname_suffix: read_optional_string(value, "hostname_suffix", source),
    port: read_optional_port(value, "port", source),
    https: read_optional_boolean(value, "https", source),
  };
}

function parse_tailscale_config(
  value: unknown,
  source: string,
): Yaml_tailscale_config | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!is_record(value)) {
    throw new Error(`${source} must be a mapping.`);
  }

  assert_known_keys(value, tailscale_keys, source);

  const mode = read_optional_string(value, "mode", source);

  if (
    mode !== undefined &&
    mode !== "direct" &&
    mode !== "proxy" &&
    mode !== "portless-proxy"
  ) {
    throw new Error(
      `${source}.mode must be "direct", "proxy", or "portless-proxy".`,
    );
  }

  return {
    enabled: read_optional_boolean(value, "enabled", source),
    mode,
    serve_port: read_optional_port(value, "serve_port", source),
  };
}

export function parse_devtree_yaml_config(
  yaml_text: string,
  source = DEVTREE_PROJECT_CONFIG_FILENAME,
): Devtree_yaml_config {
  const document = parseDocument(yaml_text);

  if (document.errors.length > 0) {
    throw new Error(`Could not parse ${source}: ${document.errors[0]?.message}`);
  }

  const raw_config = document.toJS() as unknown;

  if (raw_config === null) {
    return {};
  }

  if (!is_record(raw_config)) {
    throw new Error(`${source} must contain a YAML mapping.`);
  }

  assert_known_keys(raw_config, top_level_keys, source);

  if (raw_config.version !== undefined && raw_config.version !== 1) {
    throw new Error(`${source}.version must be 1.`);
  }

  return {
    version: raw_config.version as 1 | undefined,
    routing: parse_routing_config(raw_config.routing, `${source}.routing`),
    tailscale: parse_tailscale_config(raw_config.tailscale, `${source}.tailscale`),
  };
}

function load_yaml_file(file_path: string) {
  if (!existsSync(file_path)) {
    return {};
  }

  return parse_devtree_yaml_config(readFileSync(file_path, "utf8"), file_path);
}

function merge_yaml_config(
  base_config: Devtree_yaml_config,
  override_config: Devtree_yaml_config,
): Devtree_yaml_config {
  const defined_routing_overrides = Object.fromEntries(
    Object.entries(override_config.routing ?? {}).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Yaml_routing_config;
  const defined_tailscale_overrides = Object.fromEntries(
    Object.entries(override_config.tailscale ?? {}).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Yaml_tailscale_config;

  return {
    version: override_config.version ?? base_config.version,
    routing:
      base_config.routing || override_config.routing
        ? { ...base_config.routing, ...defined_routing_overrides }
        : undefined,
    tailscale:
      base_config.tailscale || override_config.tailscale
        ? { ...base_config.tailscale, ...defined_tailscale_overrides }
        : undefined,
  };
}

export function load_devtree_yaml_config(repo_root: string): Loaded_devtree_yaml_config {
  const project_path = resolve(repo_root, DEVTREE_PROJECT_CONFIG_FILENAME);
  const local_path = resolve_devtree_local_config_path(repo_root);
  const project = load_yaml_file(project_path);
  const local = load_yaml_file(local_path);

  return {
    project_path,
    local_path,
    project,
    local,
    merged: merge_yaml_config(project, local),
  };
}

function resolve_yaml_provider(
  provider_kind: Yaml_routing_config["provider"],
  existing_provider: Routing_provider | undefined,
): Routing_provider | undefined {
  if (!provider_kind) {
    return existing_provider;
  }

  if (existing_provider?.kind === provider_kind) {
    return existing_provider;
  }

  return { kind: provider_kind };
}

function create_yaml_hostname_resolver(
  routing_config: Yaml_routing_config,
): ((context: Routing_hostname_context) => string) | null {
  const hostname_suffix =
    routing_config.hostname_suffix ??
    (routing_config.machine_name && routing_config.base_domain
      ? `${routing_config.machine_name}.${routing_config.base_domain}`
      : null);

  if (!hostname_suffix) {
    return null;
  }

  return ({ app_name, worktree_slug }) => {
    const route_name = worktree_slug ? `${worktree_slug}--${app_name}` : app_name;
    return `${route_name}.${hostname_suffix}`;
  };
}

export function apply_devtree_yaml_config(
  config: Devtree_config,
  yaml_config: Devtree_yaml_config,
): Devtree_config {
  const yaml_routing = yaml_config.routing;
  const yaml_tailscale = yaml_config.tailscale;
  const hostname_resolver = yaml_routing
    ? create_yaml_hostname_resolver(yaml_routing)
    : null;
  const has_routing_values =
    yaml_routing !== undefined &&
    Object.values(yaml_routing).some((value) => value !== undefined);
  const has_tailscale_values =
    yaml_tailscale !== undefined &&
    Object.values(yaml_tailscale).some((value) => value !== undefined);

  return {
    ...config,
    routing: has_routing_values
      ? {
          ...config.routing,
          provider: resolve_yaml_provider(
            yaml_routing.provider,
            config.routing?.provider,
          ),
          hostname: hostname_resolver ?? config.routing?.hostname,
          port: yaml_routing.port ?? config.routing?.port,
          https: yaml_routing.https ?? config.routing?.https,
        }
      : config.routing,
    tailscale: has_tailscale_values
      ? {
          ...config.tailscale,
          enabled: yaml_tailscale.enabled ?? config.tailscale?.enabled,
          mode: yaml_tailscale.mode ?? config.tailscale?.mode,
          serve_port: yaml_tailscale.serve_port ?? config.tailscale?.serve_port,
        }
      : config.tailscale,
  };
}
