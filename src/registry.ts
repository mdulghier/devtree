import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type Registered_compose_project = {
  version: 2;
  project_name: string;
  dependency_owner: string;
  compose_project: string;
  worktree_path: string;
  dependency_name: string;
  updated_at: string;
};

export function get_project_registry_path(state_root = resolve(homedir(), ".devtree")) {
  return resolve(state_root, "projects.json");
}

function is_registered_compose_project(value: unknown): value is Registered_compose_project {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<Registered_compose_project>;

  return (
    entry.version === 2 &&
    typeof entry.project_name === "string" &&
    typeof entry.dependency_owner === "string" &&
    typeof entry.compose_project === "string" &&
    typeof entry.worktree_path === "string" &&
    typeof entry.dependency_name === "string" &&
    typeof entry.updated_at === "string"
  );
}

function read_registry(state_root?: string) {
  const registry_path = get_project_registry_path(state_root);

  if (!existsSync(registry_path)) {
    return [] as Registered_compose_project[];
  }

  const file_text = readFileSync(registry_path, "utf8").trim();

  if (!file_text) {
    return [] as Registered_compose_project[];
  }

  const parsed_entries = JSON.parse(file_text) as unknown;

  return Array.isArray(parsed_entries) ? parsed_entries.filter(is_registered_compose_project) : [];
}

function write_registry(entries: Registered_compose_project[], state_root?: string) {
  const registry_path = get_project_registry_path(state_root);

  mkdirSync(dirname(registry_path), { recursive: true });
  writeFileSync(registry_path, `${JSON.stringify(entries, null, 2)}\n`);
}

export function register_compose_project(
  entry: Omit<Registered_compose_project, "updated_at" | "version">,
  state_root?: string,
) {
  const next_entries = read_registry(state_root).filter(
    (existing_entry) =>
      !(
        existing_entry.project_name === entry.project_name &&
        existing_entry.dependency_owner === entry.dependency_owner &&
        existing_entry.dependency_name === entry.dependency_name
      ),
  );

  next_entries.push({
    ...entry,
    version: 2,
    updated_at: new Date().toISOString(),
  });
  next_entries.sort((left, right) =>
    `${left.project_name}/${left.dependency_owner}/${left.dependency_name}`.localeCompare(
      `${right.project_name}/${right.dependency_owner}/${right.dependency_name}`,
    ),
  );
  write_registry(next_entries, state_root);
}

export function unregister_compose_project(
  project_name: string,
  compose_project: string,
  state_root?: string,
) {
  const next_entries = read_registry(state_root).filter(
    (entry) => !(entry.project_name === project_name && entry.compose_project === compose_project),
  );

  write_registry(next_entries, state_root);
}

export function list_registered_compose_projects(
  project_name?: string,
  dependency_owner?: string,
  state_root?: string,
) {
  return read_registry(state_root).filter(
    (entry) =>
      (!project_name || entry.project_name === project_name) &&
      (!dependency_owner || entry.dependency_owner === dependency_owner),
  );
}

export function list_registered_dependency_owners(project_name: string, state_root?: string) {
  return Array.from(
    new Set(
      list_registered_compose_projects(project_name, undefined, state_root).map(
        (entry) => entry.dependency_owner,
      ),
    ),
  ).sort();
}
