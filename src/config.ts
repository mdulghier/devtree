import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Dependency_scope, Devtree_instance } from "./instance.ts";
import {
  apply_devtree_yaml_config,
  load_devtree_yaml_config,
  type Loaded_devtree_yaml_config,
} from "./yaml-config.ts";

export type Managed_env_entry =
  | {
      kind: "value";
      key: string;
      value: string;
    }
  | {
      kind: "comment";
      text: string;
    };

export type Resolved_env_map = Record<string, string | undefined>;

export type Session_name_context = {
  project_name: string;
  default_name: string;
  branch_name: string | null;
  worktree_name: string | null;
  is_main_checkout: boolean;
  worktree_path: string;
};

export type Routing_hostname_context = {
  project_name: string;
  session_name: string;
  endpoint_name: string;
  is_primary_endpoint: boolean;
  is_default_session: boolean;
};

export type Portless_hostname_context = Routing_hostname_context;

export type Routing_provider =
  | {
      kind: "portless";
    }
  | {
      kind: "caddy";
      admin_url?: string;
      bootstrap?: "best-effort" | "manual";
    };

export type Tailscale_mode = "direct" | "proxy" | "portless-proxy";

export type Dev_server_endpoint_target = {
  kind: "dev-server";
};

export type Port_endpoint_target = {
  kind: "port";
  host?: string;
  port: number;
};

export type Endpoint_target = Dev_server_endpoint_target | Port_endpoint_target;

export type Endpoint_config = {
  primary?: boolean;
  target: Endpoint_target | ((context: { instance: Devtree_instance }) => Endpoint_target);
};

export type Command_spec_context = {
  config: Devtree_config;
  instance: Devtree_instance;
  dependencies: Dependency_scope;
  repo_root: string;
  managed_env_values: Record<string, string>;
  effective_env_values: Record<string, string>;
};

export type Command_spec = {
  name?: string;
  command: [string, ...string[]];
  cwd?: string;
  env?: Resolved_env_map | ((context: Command_spec_context) => Resolved_env_map);
};

export type Compose_dependency_context = Command_spec_context;

export type Compose_dependency = {
  kind: "compose";
  name: string;
  file_path?: string;
  project_name?: string | ((context: Compose_dependency_context) => string);
  services?: string[];
  env?: Resolved_env_map | ((context: Compose_dependency_context) => Resolved_env_map);
};

export type Command_dependency = {
  kind: "command";
  name: string;
  start: Command_spec;
  stop?: Command_spec;
  logs?: Command_spec;
};

export type Devtree_dependency = Compose_dependency | Command_dependency;

export type Devtree_config = {
  project_name: string;
  session?: {
    name?: (context: Session_name_context) => string;
  };
  endpoints?: Record<string, Endpoint_config>;
  registry?: {
    /** @deprecated Sessions are always persisted; this option is ignored. */
    enabled?: boolean;
  };
  routing?: {
    provider?: Routing_provider;
    hostname?: (context: Routing_hostname_context) => string;
    port?: number;
    https?: boolean;
  };
  tailscale?: {
    enabled?: boolean;
    mode?: Tailscale_mode;
    serve_port?: number;
  };
  portless?: {
    enabled?: boolean;
    hostname?: (context: Portless_hostname_context) => string;
    port?: number;
    https?: boolean | "inherit";
    bootstrap?: "best-effort" | "manual";
  };
  dev_server?: {
    runner?: import("./command-builder.ts").Dev_server_runner;
  };
  env: {
    provider: "dotenv" | "varlock" | "process";
    file_path?: string;
    schema_path?: string;
    managed_block_id?: string;
    preamble?: string[];
    entries: (context: {
      config: Devtree_config;
      instance: Devtree_instance;
      dependencies: Dependency_scope;
      existing_env_values: Record<string, string>;
    }) => Managed_env_entry[];
  };
  dependencies?: Devtree_dependency[];
  hooks?: Partial<Record<"setup" | "migrate" | "pre_dev" | "post_setup", Command_spec[]>>;
  garbage_collection?: {
    registry_namespace?: string;
    docker_label_prefix?: string;
  };
};

export type Loaded_devtree_config = {
  config: Devtree_config;
  config_path: string;
  repo_root: string;
  yaml_config?: Loaded_devtree_yaml_config;
};

export function define_devtree_config(config: Devtree_config) {
  return config;
}

export function find_devtree_config(start_dir = process.cwd()) {
  let current_dir = resolve(start_dir);

  while (true) {
    const config_path = resolve(current_dir, "devtree.config.ts");

    if (existsSync(config_path)) {
      return { repo_root: current_dir, config_path };
    }

    const parent_dir = dirname(current_dir);

    if (parent_dir === current_dir) {
      throw new Error("Could not find devtree.config.ts from the current working directory.");
    }

    current_dir = parent_dir;
  }
}

export async function load_devtree_config(
  start_dir = process.cwd(),
): Promise<Loaded_devtree_config> {
  const { config_path, repo_root } = find_devtree_config(start_dir);
  const config_url = `${pathToFileURL(config_path).href}?mtime=${statSync(config_path).mtimeMs}`;
  const imported_config = (await import(config_url)) as { default?: Devtree_config };

  if (!imported_config.default) {
    throw new Error(`Expected a default export from ${config_path}.`);
  }

  const yaml_config = load_devtree_yaml_config(repo_root);

  return {
    config: apply_devtree_yaml_config(imported_config.default, yaml_config.merged),
    config_path,
    repo_root,
    yaml_config,
  };
}
