import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { Document, parseDocument } from "yaml";

import { load_devtree_yaml_config } from "./yaml-config.ts";
import { ensure_local_config_ignored } from "./yaml-config-paths.ts";

function write_document(file_path: string, document: Document) {
  mkdirSync(dirname(file_path), { recursive: true });

  const temporary_path = `${file_path}.tmp-${process.pid}-${Date.now()}`;

  try {
    writeFileSync(temporary_path, document.toString(), "utf8");
    renameSync(temporary_path, file_path);
  } catch (error) {
    if (existsSync(temporary_path)) {
      unlinkSync(temporary_path);
    }

    throw error;
  }
}

function update_yaml_file(
  file_path: string,
  values: Array<{
    path: string[];
    value: string | number | boolean | undefined;
  }>,
) {
  const document = existsSync(file_path)
    ? parseDocument(readFileSync(file_path, "utf8"))
    : new Document({});

  if (document.errors.length > 0) {
    throw new Error(`Could not update ${file_path}: ${document.errors[0]?.message}`);
  }

  for (const entry of values) {
    if (entry.value === undefined) {
      if (document.hasIn(entry.path)) {
        document.deleteIn(entry.path);
      }
    } else {
      document.setIn(entry.path, entry.value);
    }
  }

  write_document(file_path, document);
}

export type Interactive_yaml_setup_values = {
  base_domain: string;
  machine_name: string;
  port: number;
};

export function write_interactive_yaml_setup(
  repo_root: string,
  values: Interactive_yaml_setup_values,
) {
  const yaml_config = load_devtree_yaml_config(repo_root);

  update_yaml_file(yaml_config.project_path, [
    { path: ["version"], value: 1 },
    { path: ["routing", "provider"], value: "caddy" },
    { path: ["routing", "base_domain"], value: values.base_domain },
    { path: ["routing", "machine_name"], value: undefined },
    { path: ["routing", "hostname_suffix"], value: undefined },
    { path: ["routing", "port"], value: values.port },
    { path: ["routing", "https"], value: false },
    { path: ["tailscale", "enabled"], value: true },
    { path: ["tailscale", "mode"], value: "proxy" },
  ]);

  update_yaml_file(yaml_config.local_path, [
    { path: ["version"], value: 1 },
    { path: ["routing", "base_domain"], value: undefined },
    { path: ["routing", "machine_name"], value: values.machine_name },
    { path: ["routing", "hostname_suffix"], value: undefined },
  ]);

  ensure_local_config_ignored(repo_root, yaml_config.local_path);

  return {
    project_path: yaml_config.project_path,
    local_path: yaml_config.local_path,
  };
}
