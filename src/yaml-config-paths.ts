import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const DEVTREE_PROJECT_CONFIG_FILENAME = ".devtree.yml";
export const DEVTREE_LOCAL_CONFIG_FILENAME = ".devtree.local.yml";

function run_git(repo_root: string, args: string[]) {
  const result = spawnSync("git", ["-C", repo_root, ...args], {
    encoding: "utf8",
    env: process.env,
  });

  return result.status === 0 ? result.stdout.trim() : null;
}

function resolve_git_common_dir(repo_root: string) {
  const git_root = run_git(repo_root, ["rev-parse", "--show-toplevel"]);
  const raw_common_dir = run_git(repo_root, ["rev-parse", "--git-common-dir"]);
  const config_root_prefix = run_git(repo_root, ["rev-parse", "--show-prefix"]);

  if (!git_root || !raw_common_dir || config_root_prefix === null) {
    return null;
  }

  return {
    common_dir: resolve(git_root, raw_common_dir),
    config_root_prefix: config_root_prefix.replace(/\/$/u, ""),
  };
}

export function resolve_devtree_local_config_path(repo_root: string) {
  const current_path = resolve(repo_root, DEVTREE_LOCAL_CONFIG_FILENAME);

  if (existsSync(current_path)) {
    return current_path;
  }

  const git_paths = resolve_git_common_dir(repo_root);

  if (!git_paths) {
    return current_path;
  }

  const primary_worktree_root = dirname(git_paths.common_dir);
  return resolve(
    primary_worktree_root,
    git_paths.config_root_prefix,
    DEVTREE_LOCAL_CONFIG_FILENAME,
  );
}

function append_unique_line(file_path: string, line: string) {
  const existing_text = existsSync(file_path) ? readFileSync(file_path, "utf8") : "";
  const existing_lines = existing_text.split(/\r?\n/u);

  if (existing_lines.includes(line)) {
    return;
  }

  const separator = existing_text && !existing_text.endsWith("\n") ? "\n" : "";
  const next_text = `${existing_text}${separator}${line}\n`;
  const temporary_path = `${file_path}.tmp-${process.pid}-${Date.now()}`;

  mkdirSync(dirname(file_path), { recursive: true });
  writeFileSync(temporary_path, next_text, "utf8");
  renameSync(temporary_path, file_path);
}

export function ensure_local_config_ignored(repo_root: string, local_path: string) {
  const git_paths = resolve_git_common_dir(repo_root);

  if (!git_paths) {
    append_unique_line(
      resolve(dirname(local_path), ".gitignore"),
      DEVTREE_LOCAL_CONFIG_FILENAME,
    );
    return;
  }

  const local_config_pattern = git_paths.config_root_prefix
    ? `/${git_paths.config_root_prefix}/${DEVTREE_LOCAL_CONFIG_FILENAME}`
    : `/${DEVTREE_LOCAL_CONFIG_FILENAME}`;

  append_unique_line(
    resolve(git_paths.common_dir, "info", "exclude"),
    local_config_pattern,
  );
}
