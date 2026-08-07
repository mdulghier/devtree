import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { Devtree_config, Loaded_devtree_config } from "./config.ts";
import {
  create_portless_worktree_slug,
  format_public_url,
  resolve_configured_public_hostname,
  resolve_legacy_public_hostname,
  slugify,
} from "./hostname.ts";
import { resolve_routing, type Routing_provider_kind } from "./routing.ts";

export type Devtree_instance = {
  app_name: string;
  namespace: string;
  repo_root: string;
  worktree_path: string;
  worktree_slug: string | null;
  instance_id: string;
  scoped_name: string;
  env_file_path: string;
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

function get_parent_worktree_slug(repo_root: string, repo_slug: string) {
  const parent_slug = slugify(basename(dirname(repo_root)));

  if (!parent_slug || parent_slug === repo_slug) {
    return null;
  }

  return parent_slug;
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

function read_worktree_slug(repo_root: string, repo_slug: string) {
  const git_root = find_git_root(repo_root);

  if (!git_root) {
    return null;
  }

  const git_path = resolve(git_root, ".git");

  if (!lstatSync(git_path).isFile()) {
    return null;
  }

  const git_file_text = readFileSync(git_path, "utf8");
  const worktree_match = git_file_text.match(/[\\/]+worktrees[\\/]+([^\\/ \n\r]+)/);

  if (!worktree_match?.[1]) {
    return get_parent_worktree_slug(git_root, repo_slug) ?? `worktree-${get_hash_suffix(git_root)}`;
  }

  const git_worktree_slug = slugify(worktree_match[1]);

  if (!git_worktree_slug || git_worktree_slug === repo_slug) {
    return get_parent_worktree_slug(git_root, repo_slug) ?? `worktree-${get_hash_suffix(git_root)}`;
  }

  return git_worktree_slug;
}

function get_hash_suffix(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function read_branch_name(repo_root: string) {
  const branch_result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repo_root,
    encoding: "utf8",
    env: process.env,
  });

  if (branch_result.status !== 0) {
    return null;
  }

  const branch_name = branch_result.stdout.trim();

  if (!branch_name) {
    return null;
  }

  return branch_name;
}

function get_namespace(config: Devtree_config) {
  return slugify(config.namespace?.trim() || config.app_name);
}

export function create_devtree_instance(loaded_config: Loaded_devtree_config): Devtree_instance {
  const app_name = slugify(loaded_config.config.app_name);
  const namespace = get_namespace(loaded_config.config);
  const worktree_path = loaded_config.repo_root;
  const worktree_slug = read_worktree_slug(loaded_config.repo_root, namespace);
  const branch_name = worktree_slug ? read_branch_name(loaded_config.repo_root) : null;
  const branch_slug = branch_name
    ? slugify(branch_name.split("/").at(-1) ?? branch_name)
    : null;
  const instance_id = get_hash_suffix(worktree_path);
  const scoped_name = `${namespace}-${instance_id}`;
  const env_file_path = resolve(
    loaded_config.repo_root,
    loaded_config.config.env.file_path || ".env.local",
  );
  const label_prefix =
    loaded_config.config.garbage_collection?.docker_label_prefix?.trim() || "devtree";
  const registry_namespace =
    loaded_config.config.garbage_collection?.registry_namespace?.trim() || namespace;
  const routing = resolve_routing(loaded_config.config);
  const canonical_worktree_slug = routing.hostname_resolver && worktree_slug
    ? create_portless_worktree_slug(
        branch_name ?? worktree_slug,
        app_name,
        `${worktree_path}:${instance_id}`,
      )
    : null;
  const public_hostname =
    resolve_configured_public_hostname(loaded_config.config, {
      app_name,
      worktree_slug: canonical_worktree_slug,
    }) ??
    resolve_legacy_public_hostname(
      app_name,
      branch_slug ?? worktree_slug,
      loaded_config.config.routing ? {} : process.env,
    );
  const public_url = format_public_url(
    public_hostname,
    routing.https,
    routing.port,
  );

  return {
    app_name,
    namespace,
    repo_root: loaded_config.repo_root,
    worktree_path,
    worktree_slug,
    instance_id,
    scoped_name,
    env_file_path,
    public_hostname,
    public_url,
    label_prefix,
    registry_namespace,
    routing_provider: routing.provider_kind,
    routing_enabled: routing.enabled,
    portless_enabled: routing.provider_kind === "portless" && routing.enabled,
    get_scoped_name(suffix?: string) {
      return suffix ? `${scoped_name}-${slugify(suffix)}` : scoped_name;
    },
    allocate_port(name: string, base_port: number, span = 1000) {
      const hash_value = get_hash_suffix(`${worktree_path}:${slugify(name)}`);
      return base_port + (parseInt(hash_value, 16) % span);
    },
  };
}
