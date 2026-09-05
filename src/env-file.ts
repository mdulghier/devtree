import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { parseEnv } from "node:util";

import type { Loaded_devtree_config, Managed_env_entry } from "./config.ts";
import type { Devtree_instance } from "./instance.ts";

export type Ensure_env_file_result = {
  created: boolean;
  updated: boolean;
  env_file_path: string;
  managed_entries: Managed_env_entry[];
  managed_env_values: Record<string, string>;
  effective_env_values: Record<string, string>;
};

function get_block_markers(managed_block_id?: string) {
  const block_id = managed_block_id?.trim() || "devtree managed env";

  return {
    start: `# >>> ${block_id} >>>`,
    end: `# <<< ${block_id} <<<`,
  };
}

function strip_leading_preamble_blocks(file_text: string, preamble_lines: string[]) {
  const preamble_block = preamble_lines.join("\n").trim();
  let next_text = file_text.trim();

  if (!preamble_block) {
    return next_text;
  }

  while (next_text === preamble_block || next_text.startsWith(`${preamble_block}\n`)) {
    next_text = next_text.slice(preamble_block.length).trimStart();
  }

  return next_text;
}

function strip_trailing_preamble_blocks(file_text: string, preamble_lines: string[]) {
  const preamble_block = preamble_lines.join("\n").trim();
  let next_text = file_text.trim();

  if (!preamble_block) {
    return next_text;
  }

  while (next_text === preamble_block || next_text.endsWith(`\n${preamble_block}`)) {
    next_text = next_text.slice(0, next_text.length - preamble_block.length).trimEnd();
  }

  return next_text;
}

function remove_managed_block(
  file_text: string,
  start_marker: string,
  end_marker: string,
  preamble_lines: string[],
) {
  const start_index = file_text.indexOf(start_marker);
  const end_index = file_text.indexOf(end_marker);

  if (start_index === -1 && end_index === -1) {
    return file_text.trim();
  }

  if (start_index === -1) {
    return strip_leading_preamble_blocks(
      file_text.slice(end_index + end_marker.length),
      preamble_lines,
    );
  }

  if (end_index === -1 || end_index < start_index) {
    return strip_trailing_preamble_blocks(file_text.slice(0, start_index), preamble_lines);
  }

  const before_block = strip_trailing_preamble_blocks(
    file_text.slice(0, start_index),
    preamble_lines,
  );
  const after_block = strip_leading_preamble_blocks(
    file_text.slice(end_index + end_marker.length),
    preamble_lines,
  );

  return [before_block, after_block].filter(Boolean).join("\n\n");
}

function read_existing_env_file(
  env_file_path: string,
  start_marker: string,
  end_marker: string,
  preamble_lines: string[],
) {
  if (!existsSync(env_file_path)) {
    return {
      file_text: "",
      custom_text: "",
      env_values: {} as Record<string, string>,
    };
  }

  const file_text = readFileSync(env_file_path, "utf8");

  return {
    file_text,
    custom_text: remove_managed_block(file_text, start_marker, end_marker, preamble_lines),
    env_values: parseEnv(file_text) as Record<string, string>,
  };
}

function render_entry(entry: Managed_env_entry) {
  if (entry.kind === "comment") {
    return entry.text;
  }

  return `${entry.key}=${entry.value}`;
}

function get_managed_env_values(entries: Managed_env_entry[]) {
  const managed_env_values: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.kind === "value") {
      managed_env_values[entry.key] = entry.value;
    }
  }

  return managed_env_values;
}

export function resolve_env_file(
  loaded_config: Loaded_devtree_config,
  instance: Devtree_instance,
  write = false,
): Ensure_env_file_result {
  if (loaded_config.config.env.provider === "process") {
    const managed_entries = loaded_config.config.env.entries({
      config: loaded_config.config,
      instance,
      dependencies: instance.dependencies,
      existing_env_values: {},
    });
    const managed_env_values = get_managed_env_values(managed_entries);
    return {
      created: false,
      updated: false,
      env_file_path: instance.env_file_path,
      managed_entries,
      managed_env_values,
      effective_env_values: managed_env_values,
    };
  }
  const markers = get_block_markers(loaded_config.config.env.managed_block_id);
  const existing_env = read_existing_env_file(
    instance.env_file_path,
    markers.start,
    markers.end,
    loaded_config.config.env.preamble ?? [],
  );
  const managed_entries = loaded_config.config.env.entries({
    config: loaded_config.config,
    instance,
    dependencies: instance.dependencies,
    existing_env_values: existing_env.env_values,
  });
  const managed_block = [
    ...(loaded_config.config.env.preamble ?? []),
    markers.start,
    ...managed_entries.map(render_entry),
    markers.end,
  ].join("\n");
  const next_file_text =
    [managed_block, existing_env.custom_text].filter(Boolean).join("\n\n") + "\n";

  if (write && next_file_text !== existing_env.file_text) {
    writeFileSync(instance.env_file_path, next_file_text);
  }

  return {
    created: !existing_env.file_text,
    updated: next_file_text !== existing_env.file_text,
    env_file_path: instance.env_file_path,
    managed_entries,
    managed_env_values: get_managed_env_values(managed_entries),
    effective_env_values: parseEnv(next_file_text) as Record<string, string>,
  };
}

export function get_env_file_status_message(result: Ensure_env_file_result) {
  if (result.created) {
    return `Created ${result.env_file_path}`;
  }

  if (result.updated) {
    return `Updated ${result.env_file_path}`;
  }

  return `${result.env_file_path} is already up to date`;
}

export function ensure_env_file(loaded_config: Loaded_devtree_config, instance: Devtree_instance) {
  return resolve_env_file(loaded_config, instance, true);
}
