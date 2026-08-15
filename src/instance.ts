import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { Endpoint_target, Loaded_devtree_config } from "./config.ts";
import {
  create_identity_slug,
  format_public_url,
  resolve_configured_public_hostname,
  resolve_default_public_hostname,
  slugify,
} from "./hostname.ts";
import { resolve_routing, type Routing_provider_kind } from "./routing.ts";

export type Dependency_scope = {
  owner_name: string;
  scope_id: string;
  owns: boolean;
  get_scoped_name: (suffix?: string) => string;
  allocate_port: (name: string, base_port: number, span?: number) => number;
};

export type Resolved_endpoint = {
  name: string;
  primary: boolean;
  target_kind: Endpoint_target["kind"];
  target_host: string;
  target_port: number;
  public_hostname: string;
  public_url: string;
};

export type Devtree_instance = {
  project_name: string;
  session_name: string;
  dependency_owner: string;
  dependencies: Dependency_scope;
  repo_root: string;
  worktree_path: string;
  worktree_name: string | null;
  branch_name: string | null;
  is_main_checkout: boolean;
  instance_id: string;
  scoped_name: string;
  env_file_path: string;
  primary_endpoint_name: string;
  endpoints: Record<string, Resolved_endpoint>;
  public_hostname: string;
  public_url: string;
  label_prefix: string;
  registry_namespace: string;
  routing_provider: Routing_provider_kind;
  routing_enabled: boolean;
  portless_enabled: boolean;
  get_scoped_name: (suffix?: string) => string;
  allocate_port: (name: string, base_port: number, span?: number) => number;
};

export type Create_devtree_instance_options = {
  session_name?: string;
  dependency_owner?: string;
  own_dependencies?: boolean;
};

function get_hash_suffix(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function allocate_identity_port(identity: string, name: string, base_port: number, span = 1000) {
  if (!Number.isInteger(base_port) || !Number.isInteger(span) || span < 1) {
    throw new Error("Port allocation requires an integer base port and positive span.");
  }

  const hash_value = get_hash_suffix(`${identity}:${slugify(name)}`);
  return base_port + (parseInt(hash_value, 16) % span);
}

function find_git_root(start_dir: string) {
  let current_dir = resolve(start_dir);

  while (true) {
    if (existsSync(resolve(current_dir, ".git"))) {
      return current_dir;
    }

    const parent_dir = dirname(current_dir);

    if (parent_dir === current_dir) {
      return null;
    }

    current_dir = parent_dir;
  }
}

function read_branch_name(repo_root: string) {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repo_root,
    encoding: "utf8",
    env: process.env,
  });

  const branch_name = result.status === 0 ? result.stdout.trim() : "";
  return branch_name || null;
}

function read_worktree_context(repo_root: string) {
  const git_root = find_git_root(repo_root);

  if (!git_root) {
    return {
      branch_name: null,
      is_main_checkout: true,
      worktree_name: null,
    };
  }

  const git_path = resolve(git_root, ".git");
  const is_main_checkout = !lstatSync(git_path).isFile();

  if (is_main_checkout) {
    return {
      branch_name: read_branch_name(repo_root),
      is_main_checkout: true,
      worktree_name: null,
    };
  }

  const git_file_text = readFileSync(git_path, "utf8");
  const worktree_match = git_file_text.match(/[\\/]+worktrees[\\/]+([^\\/ \n\r]+)/u);

  return {
    branch_name: read_branch_name(repo_root),
    is_main_checkout: false,
    worktree_name: worktree_match?.[1] ?? basename(git_root),
  };
}

function resolve_project_name(project_name: string) {
  const normalized = slugify(project_name.trim());

  if (!normalized) {
    throw new Error("project_name must contain a letter or number.");
  }

  if (normalized.length > 63) {
    throw new Error("project_name must fit in one 63-character DNS label.");
  }

  return normalized;
}

function resolve_session_name(
  loaded_config: Loaded_devtree_config,
  project_name: string,
  worktree: ReturnType<typeof read_worktree_context>,
  requested_name?: string,
) {
  const default_name = worktree.is_main_checkout
    ? "default"
    : (worktree.branch_name ?? worktree.worktree_name ?? "session");
  const configured_name = loaded_config.config.session?.name?.({
    project_name,
    default_name,
    branch_name: worktree.branch_name,
    worktree_name: worktree.worktree_name,
    is_main_checkout: worktree.is_main_checkout,
    worktree_path: loaded_config.repo_root,
  });

  return create_identity_slug(
    requested_name ?? configured_name ?? default_name,
    loaded_config.repo_root,
    "session name",
  );
}

function create_dependency_scope(
  project_name: string,
  session_name: string,
  owner_name: string,
): Dependency_scope {
  const scope_id = get_hash_suffix(`${project_name}:dependencies:${owner_name}`);
  const scoped_name = `${project_name}-${owner_name}`;

  return {
    owner_name,
    scope_id,
    owns: session_name === owner_name,
    get_scoped_name(suffix?: string) {
      return suffix ? `${scoped_name}-${slugify(suffix)}` : scoped_name;
    },
    allocate_port(name: string, base_port: number, span = 1000) {
      return allocate_identity_port(
        `${project_name}:dependencies:${owner_name}`,
        name,
        base_port,
        span,
      );
    },
  };
}

function validate_endpoint_target(endpoint_name: string, target: Endpoint_target) {
  if (target.kind === "port") {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new Error(`Endpoint "${endpoint_name}" must target a port from 1 to 65535.`);
    }

    if (target.host && !["127.0.0.1", "localhost", "::1"].includes(target.host)) {
      throw new Error(`Endpoint "${endpoint_name}" must target a loopback host.`);
    }
  }
}

function resolve_endpoints(loaded_config: Loaded_devtree_config, instance: Devtree_instance) {
  const configured_endpoints = Object.entries(
    loaded_config.config.endpoints ?? {
      app: { primary: true, target: { kind: "dev-server" } as const },
    },
  );

  if (configured_endpoints.length === 0) {
    throw new Error("At least one endpoint is required.");
  }

  const primary_endpoints = configured_endpoints.filter(([, endpoint]) => endpoint.primary);

  if (primary_endpoints.length !== 1) {
    throw new Error("Exactly one endpoint must set primary: true.");
  }

  const routing = resolve_routing(loaded_config.config);
  const endpoints: Record<string, Resolved_endpoint> = {};
  let dev_server_count = 0;

  for (const [raw_endpoint_name, endpoint_config] of configured_endpoints) {
    const endpoint_name = slugify(raw_endpoint_name);

    if (!endpoint_name || endpoint_name !== raw_endpoint_name) {
      throw new Error(
        `Endpoint name "${raw_endpoint_name}" must already be a lowercase DNS label.`,
      );
    }

    const target =
      typeof endpoint_config.target === "function"
        ? endpoint_config.target({ instance })
        : endpoint_config.target;

    validate_endpoint_target(endpoint_name, target);

    if (target.kind === "dev-server") {
      dev_server_count += 1;
    }

    const hostname_context = {
      project_name: instance.project_name,
      session_name: instance.session_name,
      endpoint_name,
      is_primary_endpoint: endpoint_config.primary === true,
      is_default_session: instance.session_name === "default",
    };
    const public_hostname =
      resolve_configured_public_hostname(loaded_config.config, hostname_context) ??
      resolve_default_public_hostname(hostname_context);
    const target_port =
      target.kind === "dev-server"
        ? instance.allocate_port(`endpoint-${endpoint_name}`, 5173)
        : target.port;

    endpoints[endpoint_name] = {
      name: endpoint_name,
      primary: endpoint_config.primary === true,
      target_kind: target.kind,
      target_host: target.kind === "port" ? (target.host ?? "127.0.0.1") : "127.0.0.1",
      target_port,
      public_hostname,
      public_url: format_public_url(public_hostname, routing.https, routing.port),
    };
  }

  if (dev_server_count !== 1) {
    throw new Error('Exactly one endpoint must target { kind: "dev-server" }.');
  }

  return endpoints;
}

export function create_devtree_instance(
  loaded_config: Loaded_devtree_config,
  options: Create_devtree_instance_options = {},
): Devtree_instance {
  const project_name = resolve_project_name(loaded_config.config.project_name);
  const worktree = read_worktree_context(loaded_config.repo_root);
  const session_name = resolve_session_name(
    loaded_config,
    project_name,
    worktree,
    options.session_name,
  );
  const requested_owner = options.own_dependencies
    ? session_name
    : (options.dependency_owner ?? (worktree.is_main_checkout ? session_name : "default"));
  const dependency_owner = create_identity_slug(
    requested_owner,
    `${project_name}:dependencies`,
    "dependency owner",
  );
  const dependencies = create_dependency_scope(project_name, session_name, dependency_owner);
  const instance_id = get_hash_suffix(`${project_name}:session:${session_name}`);
  const scoped_name = `${project_name}-${session_name}`;
  const routing = resolve_routing(loaded_config.config);
  const primary_endpoint_entry = Object.entries(
    loaded_config.config.endpoints ?? {
      app: { primary: true, target: { kind: "dev-server" } as const },
    },
  ).find(([, endpoint]) => endpoint.primary);

  if (!primary_endpoint_entry) {
    throw new Error("Exactly one endpoint must set primary: true.");
  }

  const instance: Devtree_instance = {
    project_name,
    session_name,
    dependency_owner,
    dependencies,
    repo_root: loaded_config.repo_root,
    worktree_path: loaded_config.repo_root,
    worktree_name: worktree.worktree_name,
    branch_name: worktree.branch_name,
    is_main_checkout: worktree.is_main_checkout,
    instance_id,
    scoped_name,
    env_file_path: resolve(
      loaded_config.repo_root,
      loaded_config.config.env.file_path || ".env.local",
    ),
    primary_endpoint_name: primary_endpoint_entry[0],
    endpoints: {},
    public_hostname: "",
    public_url: "",
    label_prefix: loaded_config.config.garbage_collection?.docker_label_prefix?.trim() || "devtree",
    registry_namespace:
      loaded_config.config.garbage_collection?.registry_namespace?.trim() || project_name,
    routing_provider: routing.provider_kind,
    routing_enabled: routing.enabled,
    portless_enabled: routing.provider_kind === "portless" && routing.enabled,
    get_scoped_name(suffix?: string) {
      return suffix ? `${scoped_name}-${slugify(suffix)}` : scoped_name;
    },
    allocate_port(name: string, base_port: number, span = 1000) {
      return allocate_identity_port(
        `${project_name}:session:${session_name}`,
        name,
        base_port,
        span,
      );
    },
  };

  instance.endpoints = resolve_endpoints(loaded_config, instance);

  const primary_endpoint = instance.endpoints[instance.primary_endpoint_name];

  if (!primary_endpoint) {
    throw new Error(`Primary endpoint "${instance.primary_endpoint_name}" was not resolved.`);
  }

  instance.public_hostname = primary_endpoint.public_hostname;
  instance.public_url = primary_endpoint.public_url;

  return instance;
}
