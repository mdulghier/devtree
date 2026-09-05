import { randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Loaded_devtree_config } from "./config.ts";
import {
  create_devtree_instance,
  type Create_devtree_instance_options,
  type Devtree_instance,
  type Resolved_endpoint,
} from "./instance.ts";
import type { Routing_provider_kind } from "./routing.ts";

export type Environment_session = {
  version: 3;
  session_id: string;
  instance_id: string;
  project_name: string;
  session_name: string;
  dependency_owner: string;
  owns_dependencies: boolean;
  endpoints: Record<string, Resolved_endpoint>;
  ports: Record<string, number>;
  worktree_path: string;
  public_url: string;
  routing_provider: Routing_provider_kind;
  status: "stopped" | "starting" | "running";
  controller_pid: number | null;
  runner_pid: number | null;
  started_at: string;
};

function root_path(state_root?: string) {
  return state_root ?? resolve(homedir(), ".devtree");
}

export function get_environment_sessions_path(state_root?: string) {
  return resolve(root_path(state_root), "sessions");
}

function get_session_path(session_id: string, state_root?: string) {
  if (!/^[a-zA-Z0-9-]+$/u.test(session_id)) throw new Error("Invalid session ID.");
  return resolve(get_environment_sessions_path(state_root), `${session_id}.json`);
}

function is_process_alive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const held_locks = new Set<string>();

// All registry mutations, including migration and port selection, share this lock.
function with_registry_lock<T>(state_root: string | undefined, action: () => T): T {
  const root = root_path(state_root);
  if (held_locks.has(root)) return action();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // SQLite's file lock is released by the OS even if a controller is killed.
  // Keep the human-readable session records in JSON; this database only serializes access.
  const lock_path = resolve(root, "sessions-lock.sqlite");
  const database = new DatabaseSync(lock_path);
  chmodSync(lock_path, 0o600);
  database.exec("PRAGMA busy_timeout = 10000");
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    throw new Error(
      `Could not lock the Devtree session registry. Retry the command. ${String(error)}`,
    );
  }
  held_locks.add(root);
  try {
    return action();
  } finally {
    held_locks.delete(root);
    database.exec("ROLLBACK");
    database.close();
  }
}

function write_json(path: string, value: unknown) {
  const temporary_path = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary_path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary_path, path);
}

function write_session(session: Environment_session, state_root?: string) {
  const sessions_path = get_environment_sessions_path(state_root);
  mkdirSync(sessions_path, { mode: 0o700, recursive: true });
  chmodSync(sessions_path, 0o700);
  write_json(get_session_path(session.session_id, state_root), session);
}

function selection_path(worktree_path: string, state_root?: string) {
  const key = createHash("sha256").update(worktree_path).digest("hex");
  const directory = resolve(root_path(state_root), "selections");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resolve(directory, `${key}.json`);
}

export function list_environment_sessions(state_root?: string): Environment_session[] {
  return with_registry_lock(state_root, () => {
    const sessions_path = get_environment_sessions_path(state_root);
    if (!existsSync(sessions_path)) return [];
    const sessions: Environment_session[] = [];
    for (const filename of readdirSync(sessions_path).filter((name) => name.endsWith(".json"))) {
      const path = resolve(sessions_path, filename);
      let session: Environment_session;
      try {
        session = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`Cannot read saved session ${path}: ${String(error)}`);
      }
      const version = (session as { version: number }).version;
      if (version !== 2 && version !== 3) continue;
      if (!session.session_id || !session.endpoints || !session.worktree_path)
        throw new Error(`Invalid saved session ${path}.`);
      let changed = false;
      if (version === 2) {
        session.version = 3;
        session.ports = {};
        for (const endpoint of Object.values(session.endpoints)) {
          if (endpoint.target_kind === "dev-server") {
            session.ports[
              `${session.project_name}:session:${session.session_name}:endpoint-${endpoint.name}`
            ] = endpoint.target_port;
          }
        }
        session.status = session.runner_pid ? "running" : "starting";
        changed = true;
      }
      if (
        session.status !== "stopped" &&
        !is_process_alive(session.controller_pid) &&
        !is_process_alive(session.runner_pid)
      ) {
        session.status = "stopped";
        session.controller_pid = null;
        session.runner_pid = null;
        changed = true;
      }
      if (changed) write_session(session, state_root);
      sessions.push(session);
    }
    return sessions.sort(
      (left, right) =>
        left.project_name.localeCompare(right.project_name) ||
        left.session_name.localeCompare(right.session_name),
    );
  });
}

function new_session(instance: Devtree_instance): Environment_session {
  return {
    version: 3,
    session_id: randomUUID(),
    instance_id: instance.instance_id,
    project_name: instance.project_name,
    session_name: instance.session_name,
    dependency_owner: instance.dependency_owner,
    owns_dependencies: instance.dependencies.owns,
    endpoints: instance.endpoints,
    ports: Object.fromEntries(
      Object.values(instance.endpoints)
        .filter((endpoint) => endpoint.target_kind === "dev-server")
        .map((endpoint) => [
          `${instance.project_name}:session:${instance.session_name}:endpoint-${endpoint.name}`,
          endpoint.target_port,
        ]),
    ),
    worktree_path: instance.worktree_path,
    public_url: instance.public_url,
    routing_provider: instance.routing_provider,
    status: "stopped",
    controller_pid: null,
    runner_pid: null,
    started_at: "",
  };
}

function reserve_port(
  session_id: string,
  scope: string,
  name: string,
  base_port: number,
  span: number,
  initial_port: number,
  state_root?: string,
) {
  return with_registry_lock(state_root, () => {
    const sessions = list_environment_sessions(state_root);
    const session = sessions.find((entry) => entry.session_id === session_id);
    if (!session)
      throw new Error("This session was removed. Resolve it again before allocating ports.");
    const key = `${scope}:${name}`;
    const saved_port = sessions.map((entry) => entry.ports[key]).find((port) => port !== undefined);
    if (saved_port !== undefined) {
      if (session.ports[key] !== saved_port) {
        session.ports[key] = saved_port;
        write_session(session, state_root);
      }
      return saved_port;
    }
    if (base_port < 1 || base_port + span - 1 > 65535)
      throw new Error("Port allocation must stay between 1 and 65535.");
    const occupied = new Set(
      sessions.flatMap((entry) => [
        ...Object.values(entry.ports),
        ...Object.values(entry.endpoints).map((endpoint) => endpoint.target_port),
      ]),
    );
    for (let offset = 0; offset < span; offset += 1) {
      const port = base_port + ((initial_port - base_port + offset) % span);
      if (occupied.has(port)) continue;
      session.ports[key] = port;
      write_session(session, state_root);
      return port;
    }
    throw new Error(
      `No free Devtree port assignments in ${base_port}–${base_port + span - 1}. Remove unused sessions with devtree session remove.`,
    );
  });
}

export function get_selected_environment_session(
  project_name: string,
  worktree_path: string,
  state_root?: string,
) {
  return with_registry_lock(state_root, () => {
    const sessions = list_environment_sessions(state_root).filter(
      (entry) => entry.project_name === project_name && entry.worktree_path === worktree_path,
    );
    const path = selection_path(worktree_path, state_root);
    const id = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string) : undefined;
    return (
      sessions.find((entry) => entry.session_id === id) ??
      sessions.find((entry) => entry.status !== "stopped")
    );
  });
}

export function resolve_persisted_instance(
  loaded_config: Loaded_devtree_config,
  options: Create_devtree_instance_options,
  state_root?: string,
) {
  return with_registry_lock(state_root, () => {
    const default_instance = create_devtree_instance(loaded_config, options);
    const sessions = list_environment_sessions(state_root);
    const checkout_sessions = sessions.filter(
      (session) =>
        session.worktree_path === default_instance.worktree_path &&
        session.project_name === default_instance.project_name,
    );
    const selected_path = selection_path(default_instance.worktree_path, state_root);
    const selected_id = existsSync(selected_path)
      ? (JSON.parse(readFileSync(selected_path, "utf8")) as string)
      : undefined;
    const saved = options.session_name
      ? checkout_sessions.find((session) => session.session_name === default_instance.session_name)
      : (checkout_sessions.find((session) => session.session_id === selected_id) ??
        checkout_sessions.find((session) => session.status !== "stopped") ??
        checkout_sessions.find(
          (session) => session.session_name === default_instance.session_name,
        ));
    const resolved_options = {
      ...options,
      session_name: saved?.session_name ?? default_instance.session_name,
      dependency_owner: options.dependency_owner ?? saved?.dependency_owner,
    };
    let instance = create_devtree_instance(loaded_config, resolved_options);
    const live = sessions.find(
      (session) =>
        session.status !== "stopped" &&
        (session.worktree_path === instance.worktree_path ||
          (session.project_name === instance.project_name &&
            session.session_name === instance.session_name)),
    );
    if (
      live &&
      (live.project_name !== instance.project_name ||
        live.worktree_path !== instance.worktree_path ||
        live.session_name !== instance.session_name ||
        live.dependency_owner !== instance.dependency_owner)
    ) {
      throw new Error(
        `This checkout or session already runs session "${live.session_name}" with dependencies "${live.dependency_owner}". Stop it before changing the selection.`,
      );
    }
    const other_checkout = sessions.find(
      (entry) =>
        entry.project_name === instance.project_name &&
        entry.session_name === instance.session_name &&
        entry.worktree_path !== instance.worktree_path,
    );
    if (other_checkout)
      throw new Error(
        `Session "${instance.session_name}" belongs to checkout ${other_checkout.worktree_path}. Choose another name or remove that session from its checkout.`,
      );
    const session = saved ?? new_session(instance);
    if (!saved) {
      session.endpoints = {};
      session.ports = {};
      write_session(session, state_root);
    }
    instance = create_devtree_instance(loaded_config, {
      ...resolved_options,
      reserve_port: (scope, name, base_port, span, initial_port) =>
        reserve_port(session.session_id, scope, name, base_port, span, initial_port, state_root),
    });
    const updated = list_environment_sessions(state_root).find(
      (entry) => entry.session_id === session.session_id,
    )!;
    if (
      updated.status !== "stopped" &&
      (updated.routing_provider !== instance.routing_provider ||
        JSON.stringify(updated.endpoints) !== JSON.stringify(instance.endpoints))
    ) {
      throw new Error(
        "Endpoint configuration changed while the session is live. Stop it before applying those changes.",
      );
    }
    Object.assign(updated, {
      dependency_owner: instance.dependency_owner,
      owns_dependencies: instance.dependencies.owns,
      endpoints: instance.endpoints,
      public_url: instance.public_url,
      routing_provider: instance.routing_provider,
    });
    write_session(updated, state_root);
    write_json(selected_path, updated.session_id);
    instance.session_id = updated.session_id;
    return instance;
  });
}

export function assert_environment_session_available(
  instance: Devtree_instance,
  state_root?: string,
) {
  const sessions = list_environment_sessions(state_root).filter(
    (session) => session.status !== "stopped",
  );
  const named = sessions.find(
    (session) =>
      session.project_name === instance.project_name &&
      session.session_name === instance.session_name,
  );
  if (named)
    throw new Error(
      `Session "${instance.project_name}/${instance.session_name}" is already ${named.status} at ${named.public_url}.`,
    );
  const checkout = sessions.find((session) => session.worktree_path === instance.worktree_path);
  if (checkout)
    throw new Error(
      `Worktree "${instance.worktree_path}" already runs session "${checkout.project_name}/${checkout.session_name}". Stop it before starting another session from the same checkout.`,
    );
}

export function create_environment_session(
  instance: Devtree_instance,
  state_root?: string,
): Environment_session {
  return with_registry_lock(state_root, () => {
    assert_environment_session_available(instance, state_root);
    const session =
      list_environment_sessions(state_root).find(
        (entry) =>
          entry.instance_id === instance.instance_id &&
          entry.worktree_path === instance.worktree_path,
      ) ?? new_session(instance);
    if (instance.session_id) {
      const selected = get_selected_environment_session(
        instance.project_name,
        instance.worktree_path,
        state_root,
      );
      if (
        session.session_id !== instance.session_id ||
        selected?.session_id !== instance.session_id ||
        session.dependency_owner !== instance.dependency_owner ||
        JSON.stringify(session.endpoints) !== JSON.stringify(instance.endpoints)
      ) {
        throw new Error("Session selection changed while preparing startup. Retry devtree dev.");
      }
    }
    session.status = "starting";
    session.controller_pid = process.pid;
    session.runner_pid = null;
    session.started_at = new Date().toISOString();
    write_session(session, state_root);
    return session;
  });
}

export function set_environment_session_runner_pid(
  session: Environment_session,
  runner_pid: number,
  state_root?: string,
) {
  with_registry_lock(state_root, () => {
    session.runner_pid = runner_pid;
    session.status = "running";
    const current = list_environment_sessions(state_root).find(
      (entry) => entry.session_id === session.session_id,
    );
    if (!current) throw new Error("Session no longer exists.");
    write_session({ ...current, runner_pid, status: "running" }, state_root);
  });
}

export function stop_environment_session(session_id: string, state_root?: string) {
  with_registry_lock(state_root, () => {
    const session = list_environment_sessions(state_root).find(
      (entry) => entry.session_id === session_id,
    );
    if (!session) return;
    if (
      session.controller_pid &&
      session.controller_pid !== process.pid &&
      is_process_alive(session.controller_pid)
    )
      throw new Error("Only the session controller can mark its session stopped.");
    session.status = "stopped";
    session.controller_pid = null;
    session.runner_pid = null;
    write_session(session, state_root);
  });
}

export function remove_environment_session(session_id: string, state_root?: string) {
  with_registry_lock(state_root, () => {
    const session = list_environment_sessions(state_root).find(
      (entry) => entry.session_id === session_id,
    );
    if (session && session.status !== "stopped")
      throw new Error(
        `Session "${session.session_name}" is ${session.status}. Stop it before removing it.`,
      );
    rmSync(get_session_path(session_id, state_root), { force: true });
    if (session) {
      const path = selection_path(session.worktree_path, state_root);
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")) === session_id) rmSync(path);
    }
  });
}

export function list_dependency_stack_sessions(
  project_name: string,
  dependency_owner: string,
  state_root?: string,
) {
  return list_environment_sessions(state_root).filter(
    (session) =>
      session.status !== "stopped" &&
      session.project_name === project_name &&
      session.dependency_owner === dependency_owner,
  );
}
