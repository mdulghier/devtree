import { homedir } from "node:os";

import type { Environment_session } from "./environment-registry.ts";

type Environment_list_row = {
  instance: string;
  status: string;
  pids: string;
  url: string;
  path: string;
};

function get_environment_status(session: Environment_session) {
  return session.runner_pid === null ? "starting" : "running";
}

function get_instance_name(session: Environment_session) {
  return `${session.app_name}/${session.worktree_slug ?? "main"}`;
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
    instance: get_instance_name(session),
    status: get_environment_status(session),
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
    return "No running Devtree environments.";
  }

  const rows = sessions.map(to_row);
  const headers: Environment_list_row = {
    instance: "INSTANCE",
    status: "STATUS",
    pids: "PIDS",
    url: "URL",
    path: "PATH",
  };
  const columns = ["instance", "status", "pids", "url"] as const;
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(headers[column].length, ...rows.map((row) => row[column].length)),
    ]),
  ) as Record<(typeof columns)[number], number>;

  return [headers, ...rows]
    .map((row) =>
      [
        pad(row.instance, widths.instance),
        pad(row.status, widths.status),
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
