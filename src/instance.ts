import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { Devtree_config, Loaded_devtree_config } from "./config.ts";

export type Devtree_instance = {
  app_name: string;
  namespace: string;
  repo_root: string;
  worktree_path: string;
  worktree_slug: string | null;
  instance_id: string;
  scoped_name: string;
  env_file_path: string;
  public_url: string;
  label_prefix: string;
  registry_namespace: string;
  portless_enabled: boolean;
  get_scoped_name: (suffix?: string) => string;
  allocate_port: (name: string, base_port: number, span?: number) => number;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function get_parent_worktree_slug(repo_root: string, repo_slug: string) {
  const parent_slug = slugify(basename(dirname(repo_root)));

  if (!parent_slug || parent_slug === repo_slug) {
    return null;
  }

  return parent_slug;
}

function read_worktree_slug(repo_root: string, repo_slug: string) {
  const git_path = resolve(repo_root, ".git");

  if (!existsSync(git_path)) {
    return null;
  }

  if (!lstatSync(git_path).isFile()) {
    return null;
  }

  const git_file_text = readFileSync(git_path, "utf8");
  const worktree_match = git_file_text.match(/[\\/]+worktrees[\\/]+([^\\/ \n\r]+)/);

  if (!worktree_match?.[1]) {
    return null;
  }

  const git_worktree_slug = slugify(worktree_match[1]);

  if (!git_worktree_slug || git_worktree_slug === repo_slug) {
    return get_parent_worktree_slug(repo_root, repo_slug);
  }

  return git_worktree_slug;
}

function get_hash_suffix(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function read_branch_slug(repo_root: string) {
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

  return slugify(branch_name.split("/").at(-1) ?? branch_name);
}

function get_public_url(app_name: string, route_prefix: string | null) {
  const protocol = process.env.PORTLESS_HTTPS === "1" ? "https" : "http";
  const tld = process.env.PORTLESS_TLD?.trim() || "localhost";
  const proxy_port = process.env.PORTLESS_PORT?.trim() || "1355";
  const host = route_prefix ? `${route_prefix}.${app_name}` : app_name;

  return `${protocol}://${host}.${tld}:${proxy_port}`;
}

function get_namespace(config: Devtree_config) {
  return slugify(config.namespace?.trim() || config.app_name);
}

export function create_devtree_instance(loaded_config: Loaded_devtree_config): Devtree_instance {
  const app_name = slugify(loaded_config.config.app_name);
  const namespace = get_namespace(loaded_config.config);
  const worktree_path = loaded_config.repo_root;
  const worktree_slug = read_worktree_slug(loaded_config.repo_root, namespace);
  const branch_slug = worktree_slug ? read_branch_slug(loaded_config.repo_root) : null;
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

  return {
    app_name,
    namespace,
    repo_root: loaded_config.repo_root,
    worktree_path,
    worktree_slug,
    instance_id,
    scoped_name,
    env_file_path,
    public_url: get_public_url(app_name, branch_slug ?? worktree_slug),
    label_prefix,
    registry_namespace,
    portless_enabled:
      loaded_config.config.portless?.enabled !== false && process.env.PORTLESS !== "0",
    get_scoped_name(suffix?: string) {
      return suffix ? `${scoped_name}-${slugify(suffix)}` : scoped_name;
    },
    allocate_port(name: string, base_port: number, span = 1000) {
      const hash_value = get_hash_suffix(`${worktree_path}:${slugify(name)}`);
      return base_port + (parseInt(hash_value, 16) % span);
    },
  };
}
