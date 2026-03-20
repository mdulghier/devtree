import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type Registered_compose_project = {
  registry_namespace: string;
  compose_project: string;
  worktree_path: string;
  dependency_name: string;
};

const registry_path = resolve(homedir(), ".devtree", "projects.json");

function read_registry() {
  if (!existsSync(registry_path)) {
    return [] as Registered_compose_project[];
  }

  const file_text = readFileSync(registry_path, "utf8").trim();

  if (!file_text) {
    return [] as Registered_compose_project[];
  }

  return JSON.parse(file_text) as Registered_compose_project[];
}

function write_registry(entries: Registered_compose_project[]) {
  mkdirSync(dirname(registry_path), { recursive: true });
  writeFileSync(registry_path, JSON.stringify(entries, null, 2) + "\n");
}

export function register_compose_project(entry: Registered_compose_project) {
  const next_entries = read_registry().filter(
    (existing_entry) =>
      !(
        existing_entry.registry_namespace === entry.registry_namespace &&
        existing_entry.compose_project === entry.compose_project
      ),
  );

  next_entries.push(entry);
  next_entries.sort((left, right) => left.compose_project.localeCompare(right.compose_project));
  write_registry(next_entries);
}

export function unregister_compose_project(registry_namespace: string, compose_project: string) {
  const next_entries = read_registry().filter(
    (existing_entry) =>
      !(
        existing_entry.registry_namespace === registry_namespace &&
        existing_entry.compose_project === compose_project
      ),
  );

  write_registry(next_entries);
}

export function list_registered_compose_projects(registry_namespace: string) {
  return read_registry().filter((entry) => entry.registry_namespace === registry_namespace);
}
