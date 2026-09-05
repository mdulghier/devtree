import { autocomplete, cancel, intro, isCancel, note, outro, text } from "@clack/prompts";

import type { Loaded_devtree_config } from "./config.ts";
import {
  get_selected_environment_session,
  resolve_persisted_instance,
} from "./environment-registry.ts";
import { create_devtree_instance, type Devtree_instance } from "./instance.ts";
import { list_registered_dependency_owners } from "./registry.ts";

export type Parsed_session_options = {
  interactive: boolean;
  session_name?: string;
  dependency_owner?: string;
  own_dependencies: boolean;
  passthrough_args: string[];
};

export type Prompt_dependencies = {
  ask_name: (initial_value: string) => Promise<string | symbol>;
  ask_dependency_owner: (
    options: Array<{ value: string; label: string; hint?: string }>,
    initial_value: string,
  ) => Promise<string | symbol>;
  cancel: (message: string) => void;
  intro: (message: string) => void;
  is_cancel: (value: unknown) => boolean;
  note: (message: string, title?: string) => void;
  outro: (message: string) => void;
};

function require_option_value(args: string[], index: number, option_name: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`${option_name} requires a value.`);
  }

  return value;
}

export function parse_session_options(args: string[]): Parsed_session_options {
  const delimiter_index = args.indexOf("--");
  const option_args = delimiter_index === -1 ? args : args.slice(0, delimiter_index);
  const passthrough_args = delimiter_index === -1 ? [] : args.slice(delimiter_index + 1);
  const result: Parsed_session_options = {
    interactive: false,
    own_dependencies: false,
    passthrough_args,
  };

  for (let index = 0; index < option_args.length; index += 1) {
    const argument = option_args[index];

    if (argument === "-i" || argument === "--interactive") {
      result.interactive = true;
      continue;
    }

    if (argument === "-d") {
      result.own_dependencies = true;
      continue;
    }

    if (argument === "--name") {
      result.session_name = require_option_value(option_args, index, "--name");
      index += 1;
      continue;
    }

    if (argument?.startsWith("--name=")) {
      result.session_name = argument.slice("--name=".length);
      continue;
    }

    if (argument === "--deps") {
      const next_argument = option_args[index + 1];

      if (next_argument && !next_argument.startsWith("-")) {
        result.dependency_owner = next_argument;
        index += 1;
      } else {
        result.own_dependencies = true;
      }
      continue;
    }

    if (argument?.startsWith("--deps=")) {
      const dependency_owner = argument.slice("--deps=".length);

      if (!dependency_owner) {
        result.own_dependencies = true;
      } else {
        result.dependency_owner = dependency_owner;
      }
      continue;
    }

    throw new Error(`Unknown session option "${argument}".`);
  }

  if (result.own_dependencies && result.dependency_owner) {
    throw new Error("Choose either an owned dependency stack or a named dependency owner.");
  }

  return result;
}

function get_default_prompt_dependencies(): Prompt_dependencies {
  return {
    ask_name: (initial_value) =>
      text({
        message: "Session name",
        initialValue: initial_value,
        validate(value) {
          return value?.trim() ? undefined : "Session name is required.";
        },
      }),
    ask_dependency_owner: (options, initial_value) =>
      autocomplete({
        message: "Dependency stack",
        options,
        initialValue: initial_value,
        placeholder: "Search dependency stacks",
      }),
    cancel,
    intro,
    is_cancel: isCancel,
    note,
    outro,
  };
}

function format_summary(instance: Devtree_instance) {
  return [
    `Project       ${instance.project_name}`,
    `Session       ${instance.session_name}`,
    `Dependencies  ${instance.dependencies.owns ? "self" : instance.dependency_owner}`,
    `URL           ${instance.public_url}`,
  ].join("\n");
}

function get_dependency_options(instance: Devtree_instance) {
  const registered_owners = list_registered_dependency_owners(instance.project_name);
  const default_owner = instance.is_main_checkout ? null : "default";
  const owners = Array.from(
    new Set([...(default_owner ? [default_owner] : []), ...registered_owners]),
  ).filter((owner) => owner !== instance.session_name);

  return [
    ...owners.map((owner) => ({
      value: owner,
      label: owner === "default" ? "Reuse default" : `Reuse ${owner}`,
      hint: registered_owners.includes(owner) ? "registered" : "not started yet",
    })),
    {
      value: "__self__",
      label: `Create an isolated stack for ${instance.session_name}`,
      hint: "owned by this session",
    },
  ];
}

export async function resolve_session_instance(
  loaded_config: Loaded_devtree_config,
  parsed_options: Parsed_session_options,
  provided_prompts?: Prompt_dependencies,
  state_root?: string,
): Promise<Devtree_instance | null> {
  if (!parsed_options.interactive) {
    return resolve_persisted_instance(loaded_config, parsed_options, state_root);
  }

  const prompts = provided_prompts ?? get_default_prompt_dependencies();
  const saved = get_selected_environment_session(
    loaded_config.config.project_name,
    loaded_config.repo_root,
    state_root,
  );
  const initial_instance = create_devtree_instance(loaded_config, {
    ...parsed_options,
    session_name: parsed_options.session_name ?? saved?.session_name,
    dependency_owner: parsed_options.dependency_owner ?? saved?.dependency_owner,
  });

  prompts.intro("Devtree");

  let session_name = parsed_options.session_name;

  if (!session_name) {
    const answer = await prompts.ask_name(initial_instance.session_name);

    if (prompts.is_cancel(answer) || typeof answer !== "string") {
      prompts.cancel("Startup cancelled.");
      return null;
    }

    session_name = answer;
  }

  let dependency_owner = parsed_options.dependency_owner;
  let own_dependencies = parsed_options.own_dependencies;
  let named_instance = create_devtree_instance(loaded_config, {
    session_name,
    dependency_owner,
    own_dependencies,
  });

  if (!dependency_owner && !own_dependencies) {
    const default_owner = named_instance.dependencies.owns
      ? "__self__"
      : named_instance.dependency_owner;
    const answer = await prompts.ask_dependency_owner(
      get_dependency_options(named_instance),
      default_owner,
    );

    if (prompts.is_cancel(answer) || typeof answer !== "string") {
      prompts.cancel("Startup cancelled.");
      return null;
    }

    if (answer === "__self__") {
      own_dependencies = true;
    } else {
      dependency_owner = answer;
    }

    named_instance = create_devtree_instance(loaded_config, {
      session_name,
      dependency_owner,
      own_dependencies,
    });
  }

  prompts.note(format_summary(named_instance));
  prompts.outro("Starting development environment");
  return resolve_persisted_instance(
    loaded_config,
    { session_name, dependency_owner, own_dependencies },
    state_root,
  );
}
