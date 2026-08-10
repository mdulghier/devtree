import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Devtree_instance } from "./instance.ts";
import type { Routing_provider_kind } from "./routing.ts";

export type Environment_session = {
  version: 1;
  session_id: string;
  instance_id: string;
  app_name: string;
  worktree_slug: string | null;
  worktree_path: string;
  public_url: string;
  routing_provider: Routing_provider_kind;
  controller_pid: number;
  runner_pid: number | null;
  started_at: string;
};

export function get_environment_sessions_path(
  state_root = resolve(homedir(), ".devtree"),
) {
  return resolve(state_root, "sessions");
}

function get_session_path(session_id: string, state_root?: string) {
  return resolve(get_environment_sessions_path(state_root), `${session_id}.json`);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_positive_integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function is_environment_session(value: unknown): value is Environment_session {
  if (!is_record(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.session_id === "string" &&
    typeof value.instance_id === "string" &&
    typeof value.app_name === "string" &&
    (typeof value.worktree_slug === "string" || value.worktree_slug === null) &&
    typeof value.worktree_path === "string" &&
    typeof value.public_url === "string" &&
    (value.routing_provider === "portless" ||
      value.routing_provider === "caddy") &&
    is_positive_integer(value.controller_pid) &&
    (is_positive_integer(value.runner_pid) || value.runner_pid === null) &&
    typeof value.started_at === "string"
  );
}

function write_session(session: Environment_session, state_root?: string) {
  const sessions_path = get_environment_sessions_path(state_root);
  const session_path = get_session_path(session.session_id, state_root);
  const temporary_path = `${session_path}.${process.pid}.${randomUUID()}.tmp`;

  mkdirSync(sessions_path, { mode: 0o700, recursive: true });
  chmodSync(sessions_path, 0o700);
  writeFileSync(temporary_path, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary_path, session_path);
}

function is_process_alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function create_environment_session(
  instance: Devtree_instance,
  state_root?: string,
): Environment_session {
  const session: Environment_session = {
    version: 1,
    session_id: `${instance.instance_id}-${process.pid}-${randomUUID()}`,
    instance_id: instance.instance_id,
    app_name: instance.app_name,
    worktree_slug: instance.worktree_slug,
    worktree_path: instance.worktree_path,
    public_url: instance.public_url,
    routing_provider: instance.routing_provider,
    controller_pid: process.pid,
    runner_pid: null,
    started_at: new Date().toISOString(),
  };

  write_session(session, state_root);
  return session;
}

export function set_environment_session_runner_pid(
  session: Environment_session,
  runner_pid: number,
  state_root?: string,
) {
  session.runner_pid = runner_pid;
  write_session(session, state_root);
}

export function remove_environment_session(session_id: string, state_root?: string) {
  rmSync(get_session_path(session_id, state_root), { force: true });
}

export function list_environment_sessions(state_root?: string) {
  const sessions_path = get_environment_sessions_path(state_root);
  let filenames: string[];

  try {
    filenames = readdirSync(sessions_path).filter((filename) => filename.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const sessions: Environment_session[] = [];

  for (const filename of filenames) {
    const session_path = resolve(sessions_path, filename);

    try {
      const parsed_session = JSON.parse(readFileSync(session_path, "utf8")) as unknown;

      if (!is_environment_session(parsed_session)) {
        continue;
      }

      if (!is_process_alive(parsed_session.controller_pid)) {
        rmSync(session_path, { force: true });
        continue;
      }

      sessions.push(parsed_session);
    } catch {
      continue;
    }
  }

  return sessions.sort((left, right) => {
    const app_comparison = left.app_name.localeCompare(right.app_name);

    if (app_comparison !== 0) {
      return app_comparison;
    }

    return left.started_at.localeCompare(right.started_at);
  });
}
