import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type {
  Command_spec,
  Command_spec_context,
  Compose_dependency,
  Loaded_devtree_config,
} from "./config.ts";
import { load_devtree_config } from "./config.ts";
import { build_development_command } from "./command-builder.ts";
import { ensure_env_file, get_env_file_status_message } from "./env-file.ts";
import { run_gc } from "./gc.ts";
import { create_devtree_instance, type Devtree_instance } from "./instance.ts";
import {
  command_exists,
  run_command_capture,
  run_command_inherit,
  type Run_command_options,
} from "./process.ts";
import { register_compose_project } from "./registry.ts";

type Command_name = "deps" | "dev" | "doctor" | "env" | "gc" | "help" | "info" | "setup";

type Runtime_state = {
  loaded_config: Loaded_devtree_config;
  instance: Devtree_instance;
  env_status_message: string;
  managed_env_values: Record<string, string>;
  effective_env_values: Record<string, string>;
};

function print_help() {
  console.log("Usage: devtree <command>");
  console.log("");
  console.log("Commands:");
  console.log("  doctor [--fix]          Check local prerequisites and bootstrap portless");
  console.log("  info                    Print the current instance URLs and resource names");
  console.log("  setup                   Write env overrides, start dependencies, run hooks");
  console.log("  dev [-- <vite args>]    Start the app through devtree and portless");
  console.log("  deps start|stop|logs    Manage configured dependencies");
  console.log("  gc [--dry-run] [-v]     Remove orphaned dependency resources");
  console.log("  env write|show          Compatibility aliases for env sync and info");
}

function get_command_name(argv: string[]) {
  return (argv[0] as Command_name | undefined) ?? "help";
}

function get_portless_start_args(loaded_config: Loaded_devtree_config) {
  const args = ["proxy", "start"];
  const https_preference = loaded_config.config.portless?.https ?? "inherit";

  if (
    https_preference === true ||
    (https_preference === "inherit" && process.env.PORTLESS_HTTPS === "1")
  ) {
    args.push("--https");
  }

  return args;
}

function create_runtime_env(
  instance: Devtree_instance,
  effective_env_values: Record<string, string>,
  env_overrides?: Record<string, string | undefined>,
) {
  return {
    ...effective_env_values,
    ...env_overrides,
    DEVTREE_ACTIVE: "1",
    DEVTREE_APP_NAME: instance.app_name,
    DEVTREE_INSTANCE_ID: instance.instance_id,
    DEVTREE_NAMESPACE: instance.registry_namespace,
    DEVTREE_PUBLIC_URL: instance.public_url,
    DEVTREE_WORKTREE_PATH: instance.worktree_path,
    DEVTREE_LABEL_PREFIX: instance.label_prefix,
  };
}

function resolve_command_env(
  command_spec: Command_spec,
  context: Command_spec_context,
  env_overrides?: Record<string, string | undefined>,
) {
  const command_env =
    typeof command_spec.env === "function" ? command_spec.env(context) : command_spec.env;

  return {
    ...context.effective_env_values,
    ...command_env,
    ...env_overrides,
  };
}

function with_varlock(command_parts: string[]) {
  return ["varlock", "run", "--", ...command_parts];
}

function run_process(
  command_parts: string[],
  runtime_state: Runtime_state,
  options?: Omit<Run_command_options, "env"> & {
    env?: Record<string, string | undefined>;
    use_varlock?: boolean;
    allow_failure?: boolean;
  },
) {
  const should_use_varlock =
    options?.use_varlock !== false && runtime_state.loaded_config.config.env.provider === "varlock";
  const wrapped_command = should_use_varlock ? with_varlock(command_parts) : command_parts;
  const [command, ...args] = wrapped_command;

  return run_command_inherit(command, args, {
    cwd: options?.cwd,
    allow_failure: options?.allow_failure,
    env: create_runtime_env(
      runtime_state.instance,
      runtime_state.effective_env_values,
      options?.env,
    ),
  });
}

function get_runtime_state(loaded_config: Loaded_devtree_config) {
  const instance = create_devtree_instance(loaded_config);
  const env_result = ensure_env_file(loaded_config, instance);

  return {
    loaded_config,
    instance,
    env_status_message: get_env_file_status_message(env_result),
    managed_env_values: env_result.managed_env_values,
    effective_env_values: env_result.effective_env_values,
  };
}

function get_command_context(runtime_state: Runtime_state): Command_spec_context {
  return {
    config: runtime_state.loaded_config.config,
    instance: runtime_state.instance,
    repo_root: runtime_state.loaded_config.repo_root,
    managed_env_values: runtime_state.managed_env_values,
    effective_env_values: runtime_state.effective_env_values,
  };
}

function get_compose_dependencies(loaded_config: Loaded_devtree_config) {
  return (loaded_config.config.dependencies ?? []).filter(
    (dependency): dependency is Compose_dependency => dependency.kind === "compose",
  );
}

function resolve_compose_project_name(
  dependency: Compose_dependency,
  context: Command_spec_context,
) {
  if (!dependency.project_name) {
    return context.instance.get_scoped_name(dependency.name);
  }

  return typeof dependency.project_name === "function"
    ? dependency.project_name(context)
    : dependency.project_name;
}

function resolve_compose_env(dependency: Compose_dependency, context: Command_spec_context) {
  const compose_env =
    typeof dependency.env === "function" ? dependency.env(context) : dependency.env;
  const compose_project = resolve_compose_project_name(dependency, context);

  return {
    ...context.effective_env_values,
    ...compose_env,
    DOCKER_COMPOSE_PROJECT: compose_project,
    WORKTREE_PATH: context.instance.worktree_path,
    DEVTREE_NAMESPACE: context.instance.registry_namespace,
    DEVTREE_LABEL_PREFIX: context.instance.label_prefix,
  };
}

function run_compose_dependency(
  runtime_state: Runtime_state,
  dependency: Compose_dependency,
  subcommand: "start" | "stop" | "logs",
) {
  const context = get_command_context(runtime_state);
  const compose_file_path = resolve(
    runtime_state.loaded_config.repo_root,
    dependency.file_path || "docker-compose.yml",
  );
  const compose_project = resolve_compose_project_name(dependency, context);
  const compose_env = resolve_compose_env(dependency, context);
  const compose_args = ["compose", "-f", compose_file_path, "--project-name", compose_project];

  register_compose_project({
    registry_namespace: runtime_state.instance.registry_namespace,
    compose_project,
    worktree_path: runtime_state.instance.worktree_path,
    dependency_name: dependency.name,
  });

  if (subcommand === "start") {
    run_process(
      [
        "docker",
        ...compose_args,
        "up",
        "-d",
        "--wait",
        ...(dependency.services?.length ? dependency.services : []),
      ],
      runtime_state,
      {
        use_varlock: false,
        env: compose_env,
      },
    );
    return;
  }

  if (subcommand === "stop") {
    run_process(["docker", ...compose_args, "down"], runtime_state, {
      use_varlock: false,
      env: compose_env,
    });
    return;
  }

  run_process(
    [
      "docker",
      ...compose_args,
      "logs",
      "-f",
      ...(dependency.services?.length ? dependency.services : []),
    ],
    runtime_state,
    {
      use_varlock: false,
      env: compose_env,
    },
  );
}

function run_command_spec(runtime_state: Runtime_state, command_spec: Command_spec) {
  const context = get_command_context(runtime_state);
  const command_env = resolve_command_env(command_spec, context);

  run_process(command_spec.command, runtime_state, {
    cwd: command_spec.cwd
      ? resolve(runtime_state.loaded_config.repo_root, command_spec.cwd)
      : undefined,
    env: command_env,
  });
}

function run_hook(
  runtime_state: Runtime_state,
  hook_name: "migrate" | "post_setup" | "pre_dev" | "setup",
) {
  for (const command_spec of runtime_state.loaded_config.config.hooks?.[hook_name] ?? []) {
    run_command_spec(runtime_state, command_spec);
  }
}

function ensure_portless_ready(loaded_config: Loaded_devtree_config, should_fix = true) {
  if (loaded_config.config.portless?.enabled === false || process.env.PORTLESS === "0") {
    return;
  }

  if (!command_exists("portless")) {
    throw new Error(
      "Devtree requires `portless`, but it was not found on PATH. Install it or run with PORTLESS=0.",
    );
  }

  if (loaded_config.config.portless?.bootstrap === "manual") {
    return;
  }

  if (!should_fix) {
    const list_result = run_command_capture("portless", ["list"], { allow_failure: true });

    if (list_result.status !== 0) {
      throw new Error(
        "Portless is installed, but the proxy is not reachable. Run `vp run devtree doctor --fix`.",
      );
    }

    return;
  }

  run_command_capture("portless", get_portless_start_args(loaded_config), { allow_failure: true });
}

function resolve_require_from_root(repo_root: string) {
  return createRequire(resolve(repo_root, "package.json"));
}

function run_doctor(loaded_config: Loaded_devtree_config, fix = false) {
  const issues: string[] = [];
  const compose_dependencies = get_compose_dependencies(loaded_config);

  console.log(`[pass] config ${loaded_config.config_path}`);

  if (command_exists("git")) {
    console.log("[pass] git available");
  } else {
    issues.push("git is not available on PATH");
  }

  if (loaded_config.config.portless?.enabled === false || process.env.PORTLESS === "0") {
    console.log("[skip] portless disabled");
  } else if (!command_exists("portless")) {
    issues.push("portless is not available on PATH");
  } else {
    try {
      ensure_portless_ready(loaded_config, fix);
      console.log(fix ? "[pass] portless ready (bootstrapped)" : "[pass] portless reachable");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (compose_dependencies.length > 0) {
    const docker_result = run_command_capture("docker", ["info"], { allow_failure: true });

    if (docker_result.status === 0) {
      console.log("[pass] docker available");
    } else {
      issues.push("docker is not available or Docker Desktop is not running");
    }
  }

  if (loaded_config.config.env.provider === "varlock") {
    if (command_exists("varlock")) {
      console.log("[pass] varlock CLI available");
    } else {
      issues.push("varlock is enabled, but the `varlock` command is not available");
    }

    const require_from_root = resolve_require_from_root(loaded_config.repo_root);

    try {
      require_from_root.resolve("@varlock/vite-integration");
      console.log("[pass] @varlock/vite-integration installed");
    } catch {
      issues.push("varlock is enabled, but @varlock/vite-integration is not installed");
    }

    const schema_path = resolve(
      loaded_config.repo_root,
      loaded_config.config.env.schema_path || ".env.schema",
    );

    if (existsSync(schema_path)) {
      console.log(`[pass] varlock schema ${schema_path}`);
    } else {
      issues.push(`varlock schema file is missing: ${schema_path}`);
    }
  }

  if (issues.length === 0) {
    console.log("");
    console.log("Doctor looks clean.");
    return;
  }

  console.log("");

  for (const issue of issues) {
    console.log(`[fail] ${issue}`);
  }

  process.exit(1);
}

function print_info(runtime_state: Runtime_state) {
  console.log(`Public URL: ${runtime_state.instance.public_url}`);
  console.log(`App name: ${runtime_state.instance.app_name}`);
  console.log(`Instance ID: ${runtime_state.instance.instance_id}`);
  console.log(`Scoped name: ${runtime_state.instance.scoped_name}`);
  console.log(`Worktree path: ${runtime_state.instance.worktree_path}`);
  console.log(`Env provider: ${runtime_state.loaded_config.config.env.provider}`);
  console.log(`Env file: ${runtime_state.instance.env_file_path}`);

  for (const dependency of get_compose_dependencies(runtime_state.loaded_config)) {
    const compose_project = resolve_compose_project_name(
      dependency,
      get_command_context(runtime_state),
    );
    console.log(`Compose project (${dependency.name}): ${compose_project}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command_name = get_command_name(argv);
  const loaded_config = await load_devtree_config();

  if (command_name === "help") {
    print_help();
    return;
  }

  if (command_name === "doctor") {
    run_doctor(loaded_config, argv.includes("--fix"));
    return;
  }

  const runtime_state = get_runtime_state(loaded_config);

  if (command_name === "info") {
    console.log(runtime_state.env_status_message);
    print_info(runtime_state);
    return;
  }

  if (command_name === "env") {
    const env_subcommand = argv[1];

    if (env_subcommand === "write") {
      console.log(runtime_state.env_status_message);
      return;
    }

    if (env_subcommand === "show") {
      print_info(runtime_state);
      return;
    }

    throw new Error("Usage: vp run devtree env <write|show>");
  }

  if (command_name === "gc") {
    run_gc(loaded_config, runtime_state.instance, {
      dry_run: argv.includes("--dry-run"),
      verbose: argv.includes("--verbose") || argv.includes("-v"),
    });
    return;
  }

  console.log(runtime_state.env_status_message);

  if (command_name === "setup") {
    ensure_portless_ready(loaded_config);

    for (const dependency of loaded_config.config.dependencies ?? []) {
      if (dependency.kind === "compose") {
        run_compose_dependency(runtime_state, dependency, "start");
      } else {
        run_command_spec(runtime_state, dependency.start);
      }
    }

    run_hook(runtime_state, "setup");
    run_hook(runtime_state, "migrate");
    run_hook(runtime_state, "post_setup");

    console.log(`Open ${runtime_state.instance.public_url} after starting the app.`);
    console.log("Run `vp run devtree dev` to launch the worktree-scoped dev server.");
    return;
  }

  if (command_name === "deps") {
    const deps_subcommand = argv[1];

    if (deps_subcommand !== "start" && deps_subcommand !== "stop" && deps_subcommand !== "logs") {
      throw new Error("Usage: vp run devtree deps <start|stop|logs>");
    }

    for (const dependency of loaded_config.config.dependencies ?? []) {
      if (dependency.kind === "compose") {
        run_compose_dependency(runtime_state, dependency, deps_subcommand);
        continue;
      }

      const command_spec =
        deps_subcommand === "start"
          ? dependency.start
          : deps_subcommand === "stop"
            ? dependency.stop
            : dependency.logs;

      if (command_spec) {
        run_command_spec(runtime_state, command_spec);
      }
    }

    return;
  }

  if (command_name === "dev") {
    const extra_args = argv.slice(1);

    if (!runtime_state.instance.portless_enabled && !process.env.BETTER_AUTH_URL) {
      console.warn(
        "PORTLESS=0 disables the injected public URL. Set BETTER_AUTH_URL before signing in.",
      );
    }

    ensure_portless_ready(loaded_config);
    run_hook(runtime_state, "pre_dev");

    const development_command = build_development_command({
      app_name: runtime_state.instance.app_name,
      extra_args,
      portless_enabled: runtime_state.instance.portless_enabled,
      use_varlock: loaded_config.config.env.provider === "varlock",
    });
    const [command, ...args] = development_command;

    run_command_inherit(command, args, {
      env: create_runtime_env(runtime_state.instance, runtime_state.effective_env_values),
    });
    return;
  }

  throw new Error("Unknown command.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
