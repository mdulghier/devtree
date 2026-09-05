import { homedir } from "node:os";

import type { Environment_session } from "./environment-registry.ts";

type Environment_list_row = {
  project: string;
  session: string;
  status: string;
  dependencies: string;
  pids: string;
  url: string;
  path: string;
};

function get_environment_status(session: Environment_session) {
  return session.status;
}

function get_pid_list(session: Environment_session) {
  return [session.controller_pid, session.runner_pid].filter((pid) => pid !== null).join(",");
}

function shorten_home_path(path: string) {
  const home_path = homedir();

  if (path === home_path) {
    return "~";
  }

  return path.startsWith(`${home_path}/`) ? `~/${path.slice(home_path.length + 1)}` : path;
}

function to_row(session: Environment_session): Environment_list_row {
  return {
    project: session.project_name,
    session: session.session_name,
    status: get_environment_status(session),
    dependencies: session.owns_dependencies ? "self" : session.dependency_owner,
    pids: get_pid_list(session),
    url: session.public_url,
    path: shorten_home_path(session.worktree_path),
  };
}

function pad(value: string, width: number) {
  return value.padEnd(width);
}

export function format_environment_list(sessions: Environment_session[]) {
  if (sessions.length === 0) {
    return "No saved Devtree sessions.";
  }

  const rows = sessions.map(to_row);
  const headers: Environment_list_row = {
    project: "PROJECT",
    session: "SESSION",
    status: "STATUS",
    dependencies: "DEPS",
    pids: "PIDS",
    url: "URL",
    path: "PATH",
  };
  const columns = ["project", "session", "status", "dependencies", "pids", "url"] as const;
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(headers[column].length, ...rows.map((row) => row[column].length)),
    ]),
  ) as Record<(typeof columns)[number], number>;

  return [headers, ...rows]
    .map((row) =>
      [
        pad(row.project, widths.project),
        pad(row.session, widths.session),
        pad(row.status, widths.status),
        pad(row.dependencies, widths.dependencies),
        pad(row.pids, widths.pids),
        pad(row.url, widths.url),
        row.path,
      ].join("  "),
    )
    .join("\n");
}

export function format_environment_list_json(sessions: Environment_session[]) {
  return JSON.stringify(
    sessions.map((session) => ({
      ...session,
      status: get_environment_status(session),
    })),
    null,
    2,
  );
}
