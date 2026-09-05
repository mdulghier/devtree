import { existsSync } from "node:fs";

import type { Loaded_devtree_config } from "./config.ts";
import { list_environment_sessions } from "./environment-registry.ts";
import type { Devtree_instance } from "./instance.ts";
import { list_registered_compose_projects, unregister_compose_project } from "./registry.ts";
import { run_command_capture, run_command_inherit } from "./process.ts";

type Docker_object_kind = "container" | "network" | "volume";

type Project_resources = {
  project_name: string;
  worktree_path: string | null;
  registry_namespace: string | null;
  containers: string[];
  networks: string[];
  volumes: string[];
  sources: Set<string>;
};

type Docker_inspect_record = {
  Name?: string;
  Labels?: Record<string, string>;
  Config?: {
    Labels?: Record<string, string>;
  };
};

export type Gc_options = {
  dry_run: boolean;
  verbose: boolean;
};

export type Classified_projects = {
  active_projects: Project_resources[];
  orphan_projects: Project_resources[];
  unknown_projects: Project_resources[];
};

function get_label_keys(label_prefix: string) {
  return {
    managed: `${label_prefix}.managed`,
    namespace: `${label_prefix}.namespace`,
    worktree_path: `${label_prefix}.worktree-path`,
    compose_project: `${label_prefix}.compose-project`,
  };
}

function get_labels(record: Docker_inspect_record) {
  return record.Config?.Labels ?? record.Labels ?? {};
}

function run_json_command(command: string, args: string[]) {
  const result = run_command_capture(command, args);

  if (!result.stdout) {
    return [] as Docker_inspect_record[];
  }

  return JSON.parse(result.stdout) as Docker_inspect_record[];
}

function ensure_project_entry(
  projects: Map<string, Project_resources>,
  project_name: string,
  registry_namespace: string | null,
  worktree_path: string | null,
) {
  const existing_project = projects.get(project_name);

  if (existing_project) {
    if (!existing_project.registry_namespace && registry_namespace) {
      existing_project.registry_namespace = registry_namespace;
    }

    if (!existing_project.worktree_path && worktree_path) {
      existing_project.worktree_path = worktree_path;
    }

    return existing_project;
  }

  const project: Project_resources = {
    project_name,
    registry_namespace,
    worktree_path,
    containers: [],
    networks: [],
    volumes: [],
    sources: new Set<string>(),
  };

  projects.set(project_name, project);
  return project;
}

function read_git_worktree_paths() {
  const worktree_result = run_command_capture("git", ["worktree", "list", "--porcelain"]);
  const worktree_paths = new Set<string>();

  for (const line of worktree_result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktree_paths.add(line.slice("worktree ".length).trim());
    }
  }

  return worktree_paths;
}

function read_container_projects(instance: Devtree_instance) {
  const container_ids = run_command_capture("docker", ["ps", "-aq"])
    .stdout.split("\n")
    .filter(Boolean);

  if (container_ids.length === 0) {
    return new Map<string, Project_resources>();
  }

  const label_keys = get_label_keys(instance.label_prefix);
  const containers = run_json_command("docker", ["inspect", ...container_ids]);
  const projects = new Map<string, Project_resources>();

  for (const container of containers) {
    const labels = get_labels(container);
    const project_name = labels["com.docker.compose.project"] ?? labels[label_keys.compose_project];
    const registry_namespace = labels[label_keys.namespace] ?? null;
    const worktree_path =
      labels[label_keys.worktree_path] ?? labels["com.docker.compose.project.working_dir"] ?? null;

    if (!project_name) {
      continue;
    }

    if (
      (registry_namespace && registry_namespace !== instance.registry_namespace) ||
      (!registry_namespace && !project_name.startsWith(instance.registry_namespace))
    ) {
      continue;
    }

    const project = ensure_project_entry(projects, project_name, registry_namespace, worktree_path);

    if (container.Name) {
      project.containers.push(container.Name.replace(/^\//, ""));
    }

    project.sources.add("container");
  }

  return projects;
}

function seed_projects_from_registry(
  projects: Map<string, Project_resources>,
  instance: Devtree_instance,
) {
  for (const entry of list_registered_compose_projects(instance.project_name)) {
    ensure_project_entry(projects, entry.compose_project, entry.project_name, entry.worktree_path);
  }
}

function add_named_objects(
  projects: Map<string, Project_resources>,
  instance: Devtree_instance,
  kind: Docker_object_kind,
  names: string[],
  inspect_args: string[],
) {
  if (names.length === 0) {
    return;
  }

  const label_keys = get_label_keys(instance.label_prefix);
  const objects = run_json_command("docker", [...inspect_args, ...names]);

  for (const object of objects) {
    const labels = get_labels(object);
    const project_name = labels["com.docker.compose.project"] ?? labels[label_keys.compose_project];
    const registry_namespace = labels[label_keys.namespace] ?? null;
    const worktree_path = labels[label_keys.worktree_path] ?? null;

    if (!project_name) {
      continue;
    }

    if (
      (registry_namespace && registry_namespace !== instance.registry_namespace) ||
      (!registry_namespace && !project_name.startsWith(instance.registry_namespace))
    ) {
      continue;
    }

    const project = ensure_project_entry(projects, project_name, registry_namespace, worktree_path);

    if (kind === "network" && object.Name) {
      project.networks.push(object.Name);
    }

    if (kind === "volume" && object.Name) {
      project.volumes.push(object.Name);
    }

    project.sources.add(kind);
  }
}

function enrich_projects_with_volumes(
  projects: Map<string, Project_resources>,
  instance: Devtree_instance,
) {
  const volume_names = run_command_capture("docker", ["volume", "ls", "-q"])
    .stdout.split("\n")
    .filter(Boolean);

  add_named_objects(projects, instance, "volume", volume_names, ["volume", "inspect"]);
}

function enrich_projects_with_networks(
  projects: Map<string, Project_resources>,
  instance: Devtree_instance,
) {
  const network_names = run_command_capture("docker", ["network", "ls", "-q"])
    .stdout.split("\n")
    .filter(Boolean);

  add_named_objects(projects, instance, "network", network_names, ["network", "inspect"]);
}

function backfill_legacy_resource_names(projects: Map<string, Project_resources>) {
  const container_names = new Set(
    run_command_capture("docker", ["ps", "-a", "--format", "{{.Names}}"])
      .stdout.split("\n")
      .filter(Boolean),
  );
  const network_names = new Set(
    run_command_capture("docker", ["network", "ls", "--format", "{{.Name}}"])
      .stdout.split("\n")
      .filter(Boolean),
  );
  const volume_names = new Set(
    run_command_capture("docker", ["volume", "ls", "--format", "{{.Name}}"])
      .stdout.split("\n")
      .filter(Boolean),
  );

  for (const project of projects.values()) {
    const default_container = `${project.project_name}-db-1`;
    const default_network = `${project.project_name}_default`;
    const default_volume = `${project.project_name}_pgdata`;

    if (project.containers.length === 0 && container_names.has(default_container)) {
      project.containers.push(default_container);
    }

    if (project.networks.length === 0 && network_names.has(default_network)) {
      project.networks.push(default_network);
    }

    if (project.volumes.length === 0 && volume_names.has(default_volume)) {
      project.volumes.push(default_volume);
    }
  }
}

function is_active_worktree(project: Project_resources, active_worktrees: Set<string>) {
  if (!project.worktree_path) {
    return false;
  }

  return active_worktrees.has(project.worktree_path) && existsSync(project.worktree_path);
}

function format_list(values: string[]) {
  return values.length === 0 ? "none" : values.join(", ");
}

function print_project(project: Project_resources, state: "active" | "orphan" | "unknown") {
  const header =
    state === "active"
      ? `Active: ${project.project_name}`
      : state === "orphan"
        ? `Orphan: ${project.project_name}`
        : `Skipped: ${project.project_name}`;

  console.log(header);
  console.log(`  worktree: ${project.worktree_path ?? "unknown"}`);
  console.log(`  containers: ${format_list(project.containers)}`);
  console.log(`  networks: ${format_list(project.networks)}`);
  console.log(`  volumes: ${format_list(project.volumes)}`);
}

function remove_named_objects(command_group: string, names: string[]) {
  if (names.length === 0) {
    return;
  }

  run_command_inherit("docker", [command_group, "rm", ...names]);
}

function remove_containers(names: string[]) {
  if (names.length === 0) {
    return;
  }

  run_command_inherit("docker", ["rm", "-f", ...names]);
}

export function classify_projects(
  projects: Project_resources[],
  active_worktrees: Set<string>,
  protected_project_names = new Set<string>(),
): Classified_projects {
  const is_active = (project: Project_resources) =>
    protected_project_names.has(project.project_name) ||
    is_active_worktree(project, active_worktrees);

  return {
    active_projects: projects.filter(is_active),
    orphan_projects: projects.filter((project) => project.worktree_path && !is_active(project)),
    unknown_projects: projects.filter((project) => !project.worktree_path && !is_active(project)),
  };
}

function get_live_consumer_projects(instance: Devtree_instance) {
  const live_dependency_owners = new Set(
    list_environment_sessions()
      .filter(
        (session) => session.status !== "stopped" && session.project_name === instance.project_name,
      )
      .map((session) => session.dependency_owner),
  );
  const compose_projects = list_registered_compose_projects(instance.project_name)
    .filter((entry) => live_dependency_owners.has(entry.dependency_owner))
    .map((entry) => entry.compose_project);

  return {
    live_dependency_owner_count: live_dependency_owners.size,
    protected_project_names: new Set(compose_projects),
  };
}

export function run_gc(
  loaded_config: Loaded_devtree_config,
  instance: Devtree_instance,
  options: Gc_options,
) {
  const active_worktrees = read_git_worktree_paths();
  const live_consumers = get_live_consumer_projects(instance);
  const projects = read_container_projects(instance);

  seed_projects_from_registry(projects, instance);
  enrich_projects_with_networks(projects, instance);
  enrich_projects_with_volumes(projects, instance);
  backfill_legacy_resource_names(projects);

  const all_projects = [...projects.values()].sort((left, right) =>
    left.project_name.localeCompare(right.project_name),
  );
  const classified_projects = classify_projects(
    all_projects,
    active_worktrees,
    live_consumers.protected_project_names,
  );

  console.log("Devtree dependency garbage collection");
  console.log(`Config: ${loaded_config.config_path}`);
  console.log(`Active git worktrees: ${active_worktrees.size}`);
  console.log(`Live dependency owners: ${live_consumers.live_dependency_owner_count}`);
  console.log(`Managed Docker projects: ${all_projects.length}`);

  if (options.verbose && classified_projects.active_projects.length > 0) {
    console.log("");

    for (const project of classified_projects.active_projects) {
      print_project(project, "active");
    }
  }

  if (classified_projects.unknown_projects.length > 0) {
    console.log("");
    console.log(
      `Skipping ${classified_projects.unknown_projects.length} project(s) without worktree metadata`,
    );

    for (const project of classified_projects.unknown_projects) {
      print_project(project, "unknown");
    }
  }

  if (classified_projects.orphan_projects.length === 0) {
    console.log("");
    console.log("No orphaned dependency projects found.");
    return;
  }

  console.log("");
  console.log(
    `${options.dry_run ? "Would remove" : "Removing"} ${classified_projects.orphan_projects.length} orphaned project(s)`,
  );

  for (const project of classified_projects.orphan_projects) {
    print_project(project, "orphan");

    if (options.dry_run) {
      continue;
    }

    remove_containers(project.containers);
    remove_named_objects("network", project.networks);
    remove_named_objects("volume", project.volumes);
    unregister_compose_project(instance.project_name, project.project_name);
  }

  console.log("");
  console.log(
    options.dry_run
      ? "Dry run only. Re-run without `--dry-run` to remove the orphaned resources."
      : "Dependency garbage collection complete.",
  );
}
