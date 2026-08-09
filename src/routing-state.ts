import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type { Devtree_instance } from "./instance.ts";

export type Persisted_instance_routing = {
  instance_id: string;
  worktree_path: string;
  local_url: string;
  local_hostname: string;
  tailscale_url: string;
  tailscale_hostname: string;
  tailscale_port: number;
  tailscale_ipv4: string;
  tailscale_mapping_key: string;
  updated_at: string;
};

export type Persisted_tailscale_mapping = {
  mapping_key: string;
  node_id: string;
  serve_port: number;
  target: string;
  owned: boolean;
  consumer_instance_ids: string[];
  updated_at: string;
};

export type Active_tailscale_routing = {
  local_url: string;
  local_hostname: string;
  tailscale_url: string;
  tailscale_hostname: string;
  tailscale_port: number;
  tailscale_ipv4: string;
  mapping_key: string;
  mapping_target: string;
  mapping_owned: boolean;
};

export type Routing_state = {
  version: 1;
  instances: Record<string, Persisted_instance_routing>;
  tailscale_mappings: Record<string, Persisted_tailscale_mapping>;
};

export function get_routing_state_path(
  state_root = resolve(homedir(), ".devtree"),
) {
  return resolve(state_root, "routing-state.json");
}

export function create_empty_routing_state(): Routing_state {
  return {
    version: 1,
    instances: {},
    tailscale_mappings: {},
  };
}

export function read_routing_state(
  state_path = get_routing_state_path(),
): Routing_state {
  if (!existsSync(state_path)) {
    return create_empty_routing_state();
  }

  const file_text = readFileSync(state_path, "utf8").trim();

  if (!file_text) {
    return create_empty_routing_state();
  }

  let parsed_state: unknown;

  try {
    parsed_state = JSON.parse(file_text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Devtree routing state at ${state_path}. ${message}`);
  }

  if (
    !parsed_state ||
    typeof parsed_state !== "object" ||
    (parsed_state as { version?: unknown }).version !== 1
  ) {
    throw new Error(
      `Devtree routing state at ${state_path} uses an unsupported format.`,
    );
  }

  const routing_state = parsed_state as Partial<Routing_state>;

  return {
    version: 1,
    instances: routing_state.instances ?? {},
    tailscale_mappings: routing_state.tailscale_mappings ?? {},
  };
}

export function write_routing_state(
  routing_state: Routing_state,
  state_path = get_routing_state_path(),
) {
  mkdirSync(dirname(state_path), { recursive: true });

  const temporary_path = `${state_path}.${process.pid}.tmp`;

  writeFileSync(temporary_path, `${JSON.stringify(routing_state, null, 2)}\n`);
  renameSync(temporary_path, state_path);
}

export function get_tailscale_mapping_key(node_id: string, serve_port: number) {
  return `${node_id}:${serve_port}`;
}

export function persist_active_tailscale_routing(options: {
  active_routing: Active_tailscale_routing;
  instance: Devtree_instance;
  node_id: string;
  state_path?: string;
}) {
  const state_path = options.state_path ?? get_routing_state_path();
  const routing_state = read_routing_state(state_path);
  const now = new Date().toISOString();
  const existing_mapping =
    routing_state.tailscale_mappings[options.active_routing.mapping_key];
  const consumer_instance_ids = Array.from(
    new Set([
      ...(existing_mapping?.consumer_instance_ids ?? []),
      options.instance.instance_id,
    ]),
  ).sort();
  const mapping: Persisted_tailscale_mapping = {
    mapping_key: options.active_routing.mapping_key,
    node_id: options.node_id,
    serve_port: options.active_routing.tailscale_port,
    target: options.active_routing.mapping_target,
    owned: options.active_routing.mapping_owned,
    consumer_instance_ids,
    updated_at: now,
  };
  const instance_routing: Persisted_instance_routing = {
    instance_id: options.instance.instance_id,
    worktree_path: options.instance.worktree_path,
    local_url: options.active_routing.local_url,
    local_hostname: options.active_routing.local_hostname,
    tailscale_url: options.active_routing.tailscale_url,
    tailscale_hostname: options.active_routing.tailscale_hostname,
    tailscale_port: options.active_routing.tailscale_port,
    tailscale_ipv4: options.active_routing.tailscale_ipv4,
    tailscale_mapping_key: options.active_routing.mapping_key,
    updated_at: now,
  };

  routing_state.tailscale_mappings[mapping.mapping_key] = mapping;
  routing_state.instances[instance_routing.instance_id] = instance_routing;
  write_routing_state(routing_state, state_path);
}

export function get_persisted_active_tailscale_routing(
  instance: Devtree_instance,
  state_path = get_routing_state_path(),
): Active_tailscale_routing | null {
  const routing_state = read_routing_state(state_path);
  const instance_routing = routing_state.instances[instance.instance_id];

  if (!instance_routing || instance_routing.worktree_path !== instance.worktree_path) {
    return null;
  }

  const mapping =
    routing_state.tailscale_mappings[instance_routing.tailscale_mapping_key];

  if (!mapping) {
    return null;
  }

  return {
    local_url: instance_routing.local_url,
    local_hostname: instance_routing.local_hostname,
    tailscale_url: instance_routing.tailscale_url,
    tailscale_hostname: instance_routing.tailscale_hostname,
    tailscale_port: instance_routing.tailscale_port,
    tailscale_ipv4: instance_routing.tailscale_ipv4,
    mapping_key: instance_routing.tailscale_mapping_key,
    mapping_target: mapping.target,
    mapping_owned: mapping.owned,
  };
}

export function remove_tailscale_mapping_state(
  mapping_key: string,
  state_path = get_routing_state_path(),
) {
  const routing_state = read_routing_state(state_path);

  delete routing_state.tailscale_mappings[mapping_key];

  for (const [instance_id, instance_routing] of Object.entries(
    routing_state.instances,
  )) {
    if (instance_routing.tailscale_mapping_key === mapping_key) {
      delete routing_state.instances[instance_id];
    }
  }

  write_routing_state(routing_state, state_path);
}
