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

import type { Devtree_instance, Resolved_endpoint } from "./instance.ts";
import type { Routing_provider_kind } from "./routing.ts";

export type Environment_session = {
  version: 2;
  session_id: string;
  instance_id: string;
  project_name: string;
  session_name: string;
  dependency_owner: string;
  owns_dependencies: boolean;
  endpoints: Record<string, Resolved_endpoint>;
  worktree_path: string;
  public_url: string;
  routing_provider: Routing_provider_kind;
  controller_pid: number;
  runner_pid: number | null;
  started_at: string;
};

export function get_environment_sessions_path(state_root = resolve(homedir(), ".devtree")) {
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
    value.version === 2 &&
    typeof value.session_id === "string" &&
    typeof value.instance_id === "string" &&
    typeof value.project_name === "string" &&
    typeof value.session_name === "string" &&
    typeof value.dependency_owner === "string" &&
    typeof value.owns_dependencies === "boolean" &&
    is_record(value.endpoints) &&
    typeof value.worktree_path === "string" &&
    typeof value.public_url === "string" &&
    (value.routing_provider === "portless" || value.routing_provider === "caddy") &&
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
    version: 2,
    session_id: `${instance.instance_id}-${process.pid}-${randomUUID()}`,
    instance_id: instance.instance_id,
    project_name: instance.project_name,
    session_name: instance.session_name,
    dependency_owner: instance.dependency_owner,
    owns_dependencies: instance.dependencies.owns,
    endpoints: instance.endpoints,
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

export function assert_environment_session_available(
  instance: Devtree_instance,
  state_root?: string,
) {
  const existing_sessions = list_environment_sessions(state_root);
  const existing_session = existing_sessions.find(
    (session) =>
      session.project_name === instance.project_name &&
      session.session_name === instance.session_name,
  );

  if (existing_session) {
    throw new Error(
      `Session "${instance.project_name}/${instance.session_name}" is already ${existing_session.runner_pid ? "running" : "starting"} at ${existing_session.public_url}.`,
    );
  }

  const worktree_session = existing_sessions.find(
    (session) => session.worktree_path === instance.worktree_path,
  );

  if (worktree_session) {
    throw new Error(
      `Worktree "${instance.worktree_path}" already runs session "${worktree_session.project_name}/${worktree_session.session_name}". Stop it before starting another session from the same checkout.`,
    );
  }
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
    const project_comparison = left.project_name.localeCompare(right.project_name);

    if (project_comparison !== 0) {
      return project_comparison;
    }

    return left.session_name.localeCompare(right.session_name);
  });
}

export function list_dependency_stack_sessions(
  project_name: string,
  dependency_owner: string,
  state_root?: string,
) {
  return list_environment_sessions(state_root).filter(
    (session) =>
      session.project_name === project_name && session.dependency_owner === dependency_owner,
  );
}
