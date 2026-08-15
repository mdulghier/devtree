import { createHash } from "node:crypto";

import type { Devtree_config, Portless_hostname_context, Resolved_env_map } from "./config.ts";
import { resolve_routing } from "./routing.ts";

const DNS_LABEL_MAX_LENGTH = 63;
const DNS_HOSTNAME_MAX_LENGTH = 253;
const HASH_LENGTH = 8;

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function get_hash_suffix(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function add_hash_suffix(value: string, source: string, max_length: number) {
  const hash_suffix = get_hash_suffix(source);
  const prefix_length = max_length - hash_suffix.length - 1;

  if (prefix_length < 1) {
    throw new Error(
      `Cannot create a collision-resistant hostname label within ${max_length} characters. Shorten project_name.`,
    );
  }

  const prefix = value.slice(0, prefix_length).replace(/-+$/g, "");

  return prefix ? `${prefix}-${hash_suffix}` : hash_suffix;
}

export function create_identity_slug(
  identity: string | null,
  fallback_seed: string,
  source_name = "name",
) {
  const source = identity?.trim() || `session-${fallback_seed}`;
  const normalized = slugify(source);

  if (!normalized) {
    return add_hash_suffix("session", source, DNS_LABEL_MAX_LENGTH);
  }

  if (normalized !== source || normalized.length > DNS_LABEL_MAX_LENGTH) {
    return add_hash_suffix(normalized, source, DNS_LABEL_MAX_LENGTH);
  }

  if (!normalized) {
    throw new Error(`${source_name} must contain a letter or number.`);
  }

  return normalized;
}

export function join_identity_slugs(identities: string[]) {
  const combined = identities.join("--");

  return combined.length <= DNS_LABEL_MAX_LENGTH
    ? combined
    : add_hash_suffix(combined, combined, DNS_LABEL_MAX_LENGTH);
}

export function validate_public_hostname(hostname: string, source = "public hostname") {
  if (!hostname) {
    throw new Error(`${source} must not be empty.`);
  }

  if (hostname.length > DNS_HOSTNAME_MAX_LENGTH) {
    throw new Error(
      `${source} "${hostname}" exceeds the ${DNS_HOSTNAME_MAX_LENGTH}-character DNS hostname limit.`,
    );
  }

  const labels = hostname.split(".");

  if (labels.length < 2) {
    throw new Error(`${source} must be a complete multi-label hostname.`);
  }

  for (const label of labels) {
    if (!label) {
      throw new Error(`${source} "${hostname}" contains an empty DNS label.`);
    }

    if (label.length > DNS_LABEL_MAX_LENGTH) {
      throw new Error(
        `${source} label "${label}" exceeds the ${DNS_LABEL_MAX_LENGTH}-character DNS label limit.`,
      );
    }

    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) {
      throw new Error(
        `${source} label "${label}" must contain only lowercase letters, digits, and interior hyphens.`,
      );
    }
  }

  return hostname;
}

export function resolve_configured_public_hostname(
  config: Devtree_config,
  context: Portless_hostname_context,
) {
  const hostname_resolver = config.routing ? config.routing.hostname : config.portless?.hostname;

  if (!hostname_resolver) {
    return null;
  }

  const setting_name = config.routing ? "routing.hostname" : "portless.hostname";

  let resolved_hostname: string;

  try {
    resolved_hostname = hostname_resolver(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not resolve ${setting_name}. Check its required machine-local environment variables. ${message}`,
    );
  }

  if (typeof resolved_hostname !== "string" || !resolved_hostname.trim()) {
    throw new Error(
      `${setting_name} must return a complete hostname. Check its required machine-local environment variables.`,
    );
  }

  const hostname = resolved_hostname.trim().toLowerCase();
  const placeholder_label = hostname
    .split(".")
    .find((label) => label === "undefined" || label === "null");

  if (placeholder_label) {
    throw new Error(
      `${setting_name} resolved to the placeholder label "${placeholder_label}". Check its required machine-local environment variables.`,
    );
  }

  return validate_public_hostname(hostname, setting_name);
}

export function resolve_default_public_hostname(
  context: Portless_hostname_context,
  env: Resolved_env_map = process.env,
) {
  const tld = env.PORTLESS_TLD?.trim() || "localhost";
  const labels = [
    ...(context.is_default_session ? [] : [context.session_name]),
    ...(context.is_primary_endpoint ? [] : [context.endpoint_name]),
    context.project_name,
    tld,
  ];

  return validate_public_hostname(labels.join(".").toLowerCase(), "Devtree public hostname");
}

export function resolve_portless_https(
  config: Devtree_config,
  env: Resolved_env_map = process.env,
) {
  return resolve_routing(config, env).https;
}

export function resolve_portless_port(config: Devtree_config, env: Resolved_env_map = process.env) {
  return resolve_routing(config, env).port;
}

export function format_public_url(hostname: string, https: boolean, proxy_port: number) {
  return `${https ? "https" : "http"}://${hostname}:${proxy_port}`;
}
