import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { cancel, confirm, intro, isCancel, multiselect, note, outro, text } from "@clack/prompts";

import { slugify } from "./hostname.ts";
import {
  analyze_upgrade_config,
  migrate_upgrade_config,
  type Upgrade_allocation,
} from "./upgrade-config.ts";

export type Legacy_state_analysis = {
  legacy_project_entries: Array<Record<string, unknown>>;
  legacy_project_names: string[];
  legacy_session_paths: string[];
  live_session_names: string[];
  should_archive_routing_state: boolean;
};

export type Upgrade_prompts = {
  ask_project_name: (initial_value: string) => Promise<string | symbol>;
  ask_endpoint_name: (initial_value: string) => Promise<string | symbol>;
  select_allocations: (allocations: Upgrade_allocation[]) => Promise<number[] | symbol>;
  confirm_apply: () => Promise<boolean | symbol>;
  cancel: (message: string) => void;
  intro: (message: string) => void;
  is_cancel: (value: unknown) => boolean;
  note: (message: string, title?: string) => void;
  outro: (message: string) => void;
};

export type Upgrade_result = {
  upgraded: boolean;
  config_backup_path?: string;
  state_backup_path?: string;
  manual_steps: string[];
};

function is_process_alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read_json(file_path: string): unknown {
  try {
    return JSON.parse(readFileSync(file_path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get_string_property(record: Record<string, unknown>, property_name: string) {
  const value = record[property_name];
  return typeof value === "string" ? value : undefined;
}

function get_session_label(session: Record<string, unknown>) {
  const name =
    get_string_property(session, "session_name") ??
    get_string_property(session, "worktree_slug") ??
    "default";
  const project =
    get_string_property(session, "project_name") ??
    get_string_property(session, "app_name") ??
    "unknown";

  return `${project}/${name}`;
}

export function inspect_legacy_state(
  state_root = resolve(homedir(), ".devtree"),
): Legacy_state_analysis {
  const projects_path = resolve(state_root, "projects.json");
  const projects = existsSync(projects_path) ? read_json(projects_path) : [];
  const legacy_project_entries = Array.isArray(projects)
    ? projects.filter(
        (entry): entry is Record<string, unknown> => is_record(entry) && entry.version !== 2,
      )
    : [];
  const legacy_project_names = legacy_project_entries
    .map((entry) => entry.compose_project)
    .filter((name): name is string => typeof name === "string")
    .sort();
  const sessions_path = resolve(state_root, "sessions");
  const legacy_session_paths: string[] = [];
  const live_session_names: string[] = [];

  if (existsSync(sessions_path)) {
    for (const filename of readdirSync(sessions_path)) {
      if (!filename.endsWith(".json")) {
        continue;
      }

      const session_path = resolve(sessions_path, filename);
      const session = read_json(session_path);

      if (!is_record(session)) {
        continue;
      }

      if (session.version === 1) {
        legacy_session_paths.push(session_path);
      }

      if (typeof session.controller_pid === "number" && is_process_alive(session.controller_pid)) {
        live_session_names.push(get_session_label(session));
      }
    }
  }

  return {
    legacy_project_entries,
    legacy_project_names,
    legacy_session_paths,
    live_session_names: live_session_names.sort(),
    should_archive_routing_state:
      legacy_project_entries.length > 0 || legacy_session_paths.length > 0,
  };
}

function write_json(file_path: string, value: unknown) {
  mkdirSync(dirname(file_path), { recursive: true });
  write_file_atomically(file_path, `${JSON.stringify(value, null, 2)}\n`);
}

function archive_legacy_state(
  state_root: string,
  backup_root: string,
  state_analysis: Legacy_state_analysis,
) {
  let archived_anything = false;

  for (const session_path of state_analysis.legacy_session_paths) {
    const destination = resolve(backup_root, "sessions", basename(session_path));
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(session_path, destination);
    archived_anything = true;
  }

  if (state_analysis.legacy_project_entries.length > 0) {
    const projects_path = resolve(state_root, "projects.json");
    const projects = read_json(projects_path);
    const current_entries = Array.isArray(projects)
      ? projects.filter((entry) => is_record(entry) && entry.version === 2)
      : [];

    write_json(resolve(backup_root, "projects.json"), state_analysis.legacy_project_entries);

    if (current_entries.length > 0) {
      write_json(projects_path, current_entries);
    } else {
      rmSync(projects_path, { force: true });
    }

    archived_anything = true;
  }

  const routing_state_path = resolve(state_root, "routing-state.json");

  if (state_analysis.should_archive_routing_state && existsSync(routing_state_path)) {
    mkdirSync(backup_root, { recursive: true });
    renameSync(routing_state_path, resolve(backup_root, "routing-state.json"));
    archived_anything = true;
  }

  return archived_anything;
}

function write_file_atomically(file_path: string, contents: string) {
  const temporary_path = `${file_path}.${process.pid}.upgrade.tmp`;

  writeFileSync(temporary_path, contents);
  renameSync(temporary_path, file_path);
}

function format_timestamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

function get_backup_root(state_root: string, timestamp: string) {
  const base_path = resolve(state_root, "backups", `upgrade-0.5-${timestamp}`);
  let candidate_path = base_path;
  let suffix = 2;

  while (existsSync(candidate_path)) {
    candidate_path = `${base_path}-${suffix}`;
    suffix += 1;
  }

  return candidate_path;
}

function find_worktree_references(repo_root: string) {
  const result = spawnSync(
    "git",
    ["-C", repo_root, "grep", "-n", "-E", "worktree_slug|DEVTREE_WORKTREE|VITE_DEVTREE_WORKTREE"],
    { encoding: "utf8", env: process.env },
  );

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout.trim().split("\n");
}

function validate_slug(value: string, label: string) {
  const normalized = slugify(value.trim());

  if (!normalized) {
    return `${label} must contain a letter or number.`;
  }

  if (normalized.length > 63) {
    return `${label} must fit in one 63-character DNS label.`;
  }

  return undefined;
}

function get_default_prompts(): Upgrade_prompts {
  return {
    ask_project_name: (initial_value) =>
      text({
        message: "Project name",
        initialValue: initial_value,
        validate: (value) => validate_slug(value ?? "", "Project name"),
      }),
    ask_endpoint_name: (initial_value) =>
      text({
        message: "Primary web endpoint",
        initialValue: initial_value,
        validate: (value) => validate_slug(value ?? "", "Endpoint name"),
      }),
    select_allocations: (allocations) =>
      multiselect({
        message: "Which ports belong to reusable dependencies?",
        options: allocations.map((allocation) => ({
          value: allocation.id,
          label: `Line ${allocation.line}: ${allocation.source}`,
        })),
        initialValues: [],
        required: false,
      }),
    confirm_apply: () =>
      confirm({
        message: "Apply this upgrade?",
        initialValue: true,
      }),
    cancel,
    intro,
    is_cancel: isCancel,
    note,
    outro,
  };
}

function format_plan(options: {
  project_name: string;
  endpoint_name: string | null;
  selected_allocation_count: number;
  state_analysis: Legacy_state_analysis;
}) {
  return [
    `Project             ${options.project_name}`,
    `Primary endpoint    ${options.endpoint_name ?? "already configured"}`,
    `Dependency ports    ${options.selected_allocation_count}`,
    `Legacy sessions     ${options.state_analysis.legacy_session_paths.length}`,
    `Legacy Compose      ${options.state_analysis.legacy_project_names.length}`,
  ].join("\n");
}

function cancel_upgrade(prompts: Upgrade_prompts): Upgrade_result {
  prompts.cancel("Upgrade cancelled. No files were changed.");
  return { upgraded: false, manual_steps: [] };
}

function get_manual_steps(options: {
  needs_config_migration: boolean;
  has_custom_hostname: boolean;
  allocations: Upgrade_allocation[];
  selected_allocation_ids: number[];
  worktree_references: string[];
  legacy_project_names: string[];
}) {
  const manual_steps: string[] = [];
  const selected_ids = new Set(options.selected_allocation_ids);

  if (options.needs_config_migration && options.has_custom_hostname) {
    manual_steps.push(
      "Update the custom hostname callback for project, session, and endpoint names.",
    );
  }

  if (options.needs_config_migration) {
    for (const allocation of options.allocations) {
      if (!selected_ids.has(allocation.id)) {
        manual_steps.push(`Review original line ${allocation.line}: ${allocation.source}`);
      }
    }
  }

  if (options.worktree_references.length > 0) {
    manual_steps.push(
      `Replace worktree-specific application labels:\n${options.worktree_references.join("\n")}`,
    );
  }

  if (options.legacy_project_names.length > 0) {
    manual_steps.push(
      `Review old Docker Compose projects before removing them: ${options.legacy_project_names.join(", ")}`,
    );
  }

  return manual_steps;
}

export async function run_upgrade_command(
  repo_root: string,
  config_path: string,
  options: {
    prompts?: Upgrade_prompts;
    state_root?: string;
    now?: Date;
  } = {},
): Promise<Upgrade_result> {
  const prompts = options.prompts ?? get_default_prompts();
  const state_root = options.state_root ?? resolve(homedir(), ".devtree");
  const config_text = readFileSync(config_path, "utf8");
  const config_analysis = analyze_upgrade_config(config_text);
  const inspected_state = inspect_legacy_state(state_root);
  const state_analysis = {
    ...inspected_state,
    should_archive_routing_state:
      inspected_state.should_archive_routing_state ||
      (config_analysis.has_legacy_keys && existsSync(resolve(state_root, "routing-state.json"))),
  };
  const automatable_allocations = config_analysis.allocations.filter(
    (allocation) => allocation.automatable,
  );

  prompts.intro("Upgrade Devtree 0.4 → 0.5");

  if (state_analysis.live_session_names.length > 0) {
    prompts.cancel(
      `Stop these Devtree sessions first: ${state_analysis.live_session_names.join(", ")}`,
    );
    throw new Error("Cannot upgrade while Devtree sessions are running.");
  }

  const needs_config_migration = config_analysis.has_legacy_keys || !config_analysis.has_endpoints;
  const has_work =
    needs_config_migration ||
    state_analysis.legacy_project_entries.length > 0 ||
    state_analysis.legacy_session_paths.length > 0 ||
    state_analysis.should_archive_routing_state;

  if (!has_work) {
    prompts.outro("Nothing to upgrade.");
    return { upgraded: false, manual_steps: [] };
  }

  let project_name = config_analysis.initial_project_name;

  if (config_analysis.has_legacy_keys) {
    const answer = await prompts.ask_project_name(project_name);

    if (prompts.is_cancel(answer) || typeof answer !== "string") {
      return cancel_upgrade(prompts);
    }

    project_name = slugify(answer);
  }

  let endpoint_name: string | null = null;

  if (!config_analysis.has_endpoints) {
    const answer = await prompts.ask_endpoint_name("app");

    if (prompts.is_cancel(answer) || typeof answer !== "string") {
      return cancel_upgrade(prompts);
    }

    endpoint_name = slugify(answer);
  }

  let selected_allocation_ids: number[] = [];

  if (needs_config_migration && automatable_allocations.length > 0) {
    const answer = await prompts.select_allocations(automatable_allocations);

    if (prompts.is_cancel(answer) || !Array.isArray(answer)) {
      return cancel_upgrade(prompts);
    }

    selected_allocation_ids = answer;
  }

  prompts.note(
    format_plan({
      project_name,
      endpoint_name,
      selected_allocation_count: selected_allocation_ids.length,
      state_analysis,
    }),
    "Planned changes",
  );

  const confirmation = await prompts.confirm_apply();

  if (prompts.is_cancel(confirmation) || confirmation !== true) {
    return cancel_upgrade(prompts);
  }

  const timestamp = format_timestamp(options.now ?? new Date());
  const backup_root = get_backup_root(state_root, timestamp);
  let config_backup_path: string | undefined;

  if (needs_config_migration) {
    config_backup_path = resolve(backup_root, "devtree.config.ts");
    const migrated_config = migrate_upgrade_config(config_text, {
      project_name,
      endpoint_name,
      dependency_allocation_ids: selected_allocation_ids,
    });

    mkdirSync(backup_root, { recursive: true });
    copyFileSync(config_path, config_backup_path);
    write_file_atomically(config_path, migrated_config);
  }

  const archived_state = archive_legacy_state(state_root, backup_root, state_analysis);
  const worktree_references = needs_config_migration ? find_worktree_references(repo_root) : [];
  const manual_steps = get_manual_steps({
    needs_config_migration,
    has_custom_hostname: config_analysis.has_custom_hostname,
    allocations: config_analysis.allocations,
    selected_allocation_ids,
    worktree_references,
    legacy_project_names: state_analysis.legacy_project_names,
  });

  prompts.note(
    manual_steps.length > 0 ? manual_steps.join("\n\n") : "No manual changes detected.",
    "Review next",
  );
  prompts.outro(`Upgrade written. Backup: ${backup_root}`);

  return {
    upgraded: true,
    config_backup_path,
    state_backup_path: archived_state ? backup_root : undefined,
    manual_steps,
  };
}
