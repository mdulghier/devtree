import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type {
  Command_spec,
  Command_spec_context,
  Compose_dependency,
  Loaded_devtree_config,
} from "./config.ts";
import {
  create_caddy_route,
  get_caddy_route_id,
  register_caddy_route,
  remove_caddy_route,
} from "./caddy.ts";
import { ensure_caddy_process } from "./caddy-process.ts";
import { find_devtree_config, load_devtree_config } from "./config.ts";
import {
  build_development_command,
  get_dev_server_command,
  type Dev_server_runner,
} from "./command-builder.ts";
import { get_proxy_mode_configuration_error, is_proxy_tailscale_mode } from "./doctor.ts";
import { ensure_env_file, resolve_env_file, get_env_file_status_message } from "./env-file.ts";
import { format_environment_list, format_environment_list_json } from "./environment-list.ts";
import {
  create_environment_session,
  list_dependency_stack_sessions,
  list_environment_sessions,
  get_selected_environment_session,
  remove_environment_session,
  stop_environment_session,
  set_environment_session_runner_pid,
} from "./environment-registry.ts";
import { run_gc } from "./gc.ts";
import {
  format_local_hosts_section,
  format_tailscale_hosts_section,
  is_localhost_hostname,
  resolve_tailscale_ipv4,
} from "./hosts.ts";
import { create_devtree_instance, type Devtree_instance } from "./instance.ts";
import { format_routing_info_lines } from "./info.ts";
import { resolve_portless_https, resolve_portless_port } from "./hostname.ts";
import { get_portless_alias_add_args, get_portless_alias_remove_args } from "./portless.ts";
import {
  command_exists,
  run_command_capture,
  run_command_inherit,
  run_command_inherit_async,
  type Run_command_options,
} from "./process.ts";
import {
  list_registered_compose_projects,
  register_compose_project,
  unregister_compose_project,
} from "./registry.ts";
import {
  get_persisted_active_tailscale_routing,
  type Active_tailscale_routing,
} from "./routing-state.ts";
import { resolve_routing } from "./routing.ts";
import { assert_dev_server_port_available } from "./server-port.ts";
import { format_env_export } from "./env-export.ts";
import { create_runtime_env } from "./runtime-env.ts";
import { parse_session_options, resolve_session_instance } from "./session-options.ts";
import { resolve_tailscale, type Resolved_tailscale } from "./tailscale.ts";
import { validate_tailscale_hostname } from "./tailscale-dns.ts";
import {
  describe_tailscale_serve_status,
  ensure_tailscale_serve,
  inspect_tailscale_serve,
  remove_owned_tailscale_serve,
  resolve_tailscale_serve_port,
  resolve_tailscale_application_routing,
} from "./tailscale-serve.ts";

type Command_name =
  | "config"
  | "deps"
  | "dev"
  | "doctor"
  | "env"
  | "exec"
  | "gc"
  | "help"
  | "hosts"
  | "info"
  | "list"
  | "mise"
  | "session"
  | "setup"
  | "tailscale"
  | "upgrade";

type Runtime_state = {
  loaded_config: Loaded_devtree_config;
  instance: Devtree_instance;
  managed_env_values: Record<string, string>;
  effective_env_values: Record<string, string>;
  tailscale: Resolved_tailscale;
  active_tailscale_routing: Active_tailscale_routing | null;
};

function print_help() {
  console.log("Usage: devtree <command>");
  console.log("");
  console.log("Commands:");
  console.log("  doctor [--fix]          Check local prerequisites, routing, and Tailscale");
  console.log("  config <key> [value]    Read or write a config value in devtree.config.ts");
  console.log("  info [session options]  Print resolved URLs and resource names");
  console.log("  list [--json]           List saved Devtree sessions on this machine");
  console.log("  tailscale status|remove Inspect or safely remove Devtree's Serve mapping");
  console.log("  hosts [session options] Print endpoint hosts-file entries");
  console.log(
    "  setup [-i] [session options]  Configure Devtree, sync env, and start dependencies",
  );
  console.log("  upgrade                 Upgrade a Devtree 0.4 project interactively");
  console.log("  dev [-i] [--name NAME] [--deps [OWNER] | -d] [-- <vite args>]");
  console.log("  deps start|stop|logs [session options]  Manage configured dependencies");
  console.log("  exec [session options] -- <command>  Run with the session environment");
  console.log("  Session options: --name NAME, --deps OWNER, -d (own dependencies)");
  console.log("  gc [--dry-run] [-v]     Remove orphaned dependency resources");
  console.log("  mise install             Install or update the bundled mise env adapter");
  console.log(
    "  session remove [--name NAME|SESSION_ID]  Remove a stopped session and release its ports",
  );
  console.log("  env [--json|--shell] [session options]  Export the session environment");
  console.log("  env write|show [session options]  Sync env or inspect the selected session");
}

function get_command_name(argv: string[]) {
  return (argv[0] as Command_name | undefined) ?? "help";
}

function get_portless_start_args(loaded_config: Loaded_devtree_config) {
  const args = ["proxy", "start", "--port", String(resolve_portless_port(loaded_config.config))];

  args.push(resolve_portless_https(loaded_config.config) ? "--https" : "--no-tls");

  return args;
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
    cwd: options?.cwd ?? runtime_state.loaded_config.repo_root,
    allow_failure: options?.allow_failure,
    env: create_runtime_env(
      runtime_state.instance,
      runtime_state.effective_env_values,
      runtime_state.tailscale,
      options?.env,
      runtime_state.active_tailscale_routing,
    ),
  });
}

function get_runtime_state(
  loaded_config: Loaded_devtree_config,
  instance = create_devtree_instance(loaded_config),
) {
  const env_result = resolve_env_file(loaded_config, instance);
  const tailscale = resolve_tailscale(loaded_config.config);
  const persisted_tailscale_routing = get_persisted_active_tailscale_routing(instance);
  const routing = resolve_routing(loaded_config.config);
  const active_tailscale_routing =
    is_proxy_tailscale_mode(tailscale.mode) &&
    tailscale.connected &&
    tailscale.node_id &&
    tailscale.ipv4
      ? resolve_tailscale_application_routing({
          instance,
          tailscale,
          serve_port: get_tailscale_serve_port(loaded_config),
          mapping_owned: persisted_tailscale_routing?.mapping_owned ?? false,
          target: `localhost:${routing.port}`,
        })
      : null;

  return {
    loaded_config,
    instance,
    managed_env_values: env_result.managed_env_values,
    effective_env_values: env_result.effective_env_values,
    tailscale,
    active_tailscale_routing,
  };
}

function sync_runtime_env(runtime_state: Runtime_state) {
  const instance = runtime_state.instance;
  const conflicting_session = list_environment_sessions().find(
    (session) =>
      session.status !== "stopped" &&
      session.worktree_path === instance.worktree_path &&
      (session.project_name !== instance.project_name ||
        session.session_name !== instance.session_name ||
        session.dependency_owner !== instance.dependency_owner),
  );
  if (conflicting_session) {
    throw new Error(
      `Cannot rewrite the environment while this checkout runs session "${conflicting_session.session_name}" with dependencies "${conflicting_session.dependency_owner}".`,
    );
  }
  const env_result = ensure_env_file(runtime_state.loaded_config, instance);
  runtime_state.managed_env_values = env_result.managed_env_values;
  runtime_state.effective_env_values = env_result.effective_env_values;
  if (runtime_state.loaded_config.config.env.provider !== "process") {
    console.log(get_env_file_status_message(env_result));
  }
}

function print_tailscale_status(runtime_state: Runtime_state) {
  const { active_tailscale_routing, tailscale } = runtime_state;

  if (!tailscale.enabled) {
    return;
  }

  if (is_proxy_tailscale_mode(tailscale.mode) && active_tailscale_routing) {
    console.log(
      `[devtree] Tailscale Serve tcp:${active_tailscale_routing.tailscale_port} -> ${active_tailscale_routing.mapping_target}`,
    );
    console.log(`[devtree] Tailscale application URL ${active_tailscale_routing.tailscale_url}`);
    return;
  }

  if (tailscale.mode === "direct" && tailscale.host) {
    console.log(`[devtree] Tailscale host ${tailscale.host}`);
    return;
  }

  console.warn(
    `[devtree] ${tailscale.error ?? "Tailscale is enabled, but is not connected"}. Vite will stay loopback-only.`,
  );
}

function get_command_context(runtime_state: Runtime_state): Command_spec_context {
  return {
    config: runtime_state.loaded_config.config,
    instance: runtime_state.instance,
    dependencies: runtime_state.instance.dependencies,
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
    return context.dependencies.get_scoped_name(dependency.name);
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
    DEVTREE_PROJECT_NAME: context.instance.project_name,
    DEVTREE_DEPENDENCY_OWNER: context.instance.dependency_owner,
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
    register_compose_project({
      project_name: runtime_state.instance.project_name,
      dependency_owner: runtime_state.instance.dependency_owner,
      compose_project,
      worktree_path: runtime_state.instance.worktree_path,
      dependency_name: dependency.name,
    });
    return;
  }

  if (subcommand === "stop") {
    run_process(["docker", ...compose_args, "down"], runtime_state, {
      use_varlock: false,
      env: compose_env,
    });
    unregister_compose_project(runtime_state.instance.project_name, compose_project);
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
  const routing = resolve_routing(loaded_config.config);

  if (routing.provider_kind !== "portless" || !routing.enabled) {
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
        "Portless is installed, but the proxy is not reachable. Run `pnpm devtree doctor --fix`.",
      );
    }

    return;
  }

  run_command_capture("portless", get_portless_start_args(loaded_config), { allow_failure: true });
}

async function ensure_routing_ready(loaded_config: Loaded_devtree_config, should_fix = true) {
  const routing = resolve_routing(loaded_config.config);

  if (!routing.enabled) {
    return;
  }

  if (routing.provider_kind === "portless") {
    ensure_portless_ready(loaded_config, should_fix);
    return;
  }

  if (!routing.caddy_admin_url) {
    throw new Error("Caddy routing requires a local admin URL.");
  }

  await ensure_caddy_process({
    admin_url: routing.caddy_admin_url,
    public_port: routing.port,
    should_start: should_fix && routing.bootstrap !== "manual",
  });
}

function get_tailscale_serve_port(loaded_config: Loaded_devtree_config) {
  const routing = resolve_routing(loaded_config.config);

  return resolve_tailscale_serve_port(loaded_config.config.tailscale?.serve_port, routing.port);
}

function require_proxy_tailscale(runtime_state: Runtime_state) {
  const { tailscale } = runtime_state;

  if (!tailscale.cli_available) {
    throw new Error(
      "Tailscale proxy mode requires the `tailscale` command. Install Tailscale, sign in, and try again.",
    );
  }

  if (!tailscale.connected || !tailscale.ipv4 || !tailscale.node_id) {
    throw new Error(
      tailscale.error ??
        "Tailscale proxy mode requires a connected client with an IPv4 address. Run `tailscale status`, sign in if necessary, and try again.",
    );
  }
}

async function ensure_tailscale_proxy_ready(runtime_state: Runtime_state) {
  if (!is_proxy_tailscale_mode(runtime_state.tailscale.mode)) {
    return;
  }

  require_proxy_tailscale(runtime_state);

  for (const endpoint of Object.values(runtime_state.instance.endpoints)) {
    await validate_tailscale_hostname(
      endpoint.public_hostname,
      runtime_state.tailscale.ipv4 as string,
    );
  }

  const routing = resolve_routing(runtime_state.loaded_config.config);

  runtime_state.active_tailscale_routing = ensure_tailscale_serve({
    instance: runtime_state.instance,
    tailscale: runtime_state.tailscale,
    routing_port: routing.port,
    serve_port: get_tailscale_serve_port(runtime_state.loaded_config),
  });
}

function print_application_urls(runtime_state: Runtime_state) {
  const active_tailscale_routing = runtime_state.active_tailscale_routing;

  console.log("");

  if (active_tailscale_routing) {
    console.log(`Open ${active_tailscale_routing.tailscale_url}`);
    console.log(`Tailscale hostname: ${active_tailscale_routing.tailscale_hostname}`);
    console.log(`Tailscale port: ${active_tailscale_routing.tailscale_port}`);

    if (active_tailscale_routing.local_url !== active_tailscale_routing.tailscale_url) {
      console.log(`Local URL: ${active_tailscale_routing.local_url}`);
    }

    for (const endpoint of Object.values(runtime_state.instance.endpoints)) {
      if (!endpoint.primary) {
        console.log(`${endpoint.name}: ${endpoint.public_url}`);
      }
    }

    return;
  }

  console.log(`Open ${runtime_state.instance.public_url}`);

  for (const endpoint of Object.values(runtime_state.instance.endpoints)) {
    if (!endpoint.primary) {
      console.log(`${endpoint.name}: ${endpoint.public_url}`);
    }
  }
}

function resolve_require_from_root(repo_root: string) {
  return createRequire(resolve(repo_root, "package.json"));
}

function get_dev_server_runner(loaded_config: Loaded_devtree_config): Dev_server_runner {
  const runner = loaded_config.config.dev_server?.runner;

  if (runner === undefined || runner === "vite-plus" || runner === "vite") {
    return runner ?? "vite-plus";
  }

  if (typeof runner === "object" && runner.kind === "mise" && runner.task?.trim()) return runner;
  throw new Error(
    'dev_server.runner must be "vite-plus", "vite", or { kind: "mise", task: "task-name" }.',
  );
}

function ensure_proxy_mode_configuration(
  loaded_config: Loaded_devtree_config,
  instance: Devtree_instance,
) {
  const configuration_error = get_proxy_mode_configuration_error(loaded_config.config, instance);

  if (configuration_error) {
    throw new Error(configuration_error);
  }
}

async function run_doctor(loaded_config: Loaded_devtree_config, fix = false) {
  const issues: string[] = [];
  const compose_dependencies = get_compose_dependencies(loaded_config);
  const tailscale = resolve_tailscale(loaded_config.config);
  const dev_server_runner = get_dev_server_runner(loaded_config);
  const dev_server_command = get_dev_server_command(dev_server_runner);
  let instance: Devtree_instance | undefined;
  let routing_ready = false;

  console.log(`[pass] config ${loaded_config.config_path}`);

  try {
    instance = (await resolve_session_instance(loaded_config, parse_session_options([])))!;
    console.log(`[pass] public hostname ${instance.public_hostname}`);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const proxy_configuration_error = get_proxy_mode_configuration_error(
    loaded_config.config,
    instance,
  );

  if (proxy_configuration_error) {
    issues.push(proxy_configuration_error);
  }

  if (command_exists("git")) {
    console.log("[pass] git available");
  } else {
    issues.push("git is not available on PATH");
  }

  if (command_exists(dev_server_command)) {
    console.log(`[pass] dev server runner ${dev_server_command} available`);
    if (typeof dev_server_runner === "object") {
      const task = run_command_capture(
        "mise",
        ["tasks", "info", dev_server_runner.task, "--json"],
        { cwd: loaded_config.repo_root, allow_failure: true },
      );
      if (task.status !== 0)
        issues.push(
          `mise server task ${dev_server_runner.task} is unavailable: ${task.stderr || task.stdout}`,
        );
      else if (/\bdevtree\s+dev\b/u.test(String(JSON.parse(task.stdout).run)))
        issues.push("The mise server task must launch Vite, not devtree dev.");
    }
  } else {
    issues.push(`dev server runner ${dev_server_command} is not available on PATH`);
  }

  if (instance) {
    const routing = resolve_routing(loaded_config.config);

    if (!routing.enabled) {
      console.log(`[skip] ${routing.provider_kind} routing disabled`);
    } else if (routing.provider_kind === "portless") {
      if (!command_exists("portless")) {
        issues.push("portless is not available on PATH");
      } else {
        try {
          ensure_portless_ready(loaded_config, fix);
          routing_ready = true;
          console.log(fix ? "[pass] portless ready (bootstrapped)" : "[pass] portless reachable");
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
    } else if (!command_exists("caddy")) {
      issues.push(
        "caddy routing is configured, but `caddy` is not available on PATH. Install Caddy and run `pnpm devtree doctor --fix` again.",
      );
    } else if (!routing.caddy_admin_url) {
      issues.push("caddy routing is configured without an admin URL");
    } else {
      try {
        await ensure_routing_ready(loaded_config, fix);
        routing_ready = true;
        console.log(
          fix
            ? `[pass] caddy ready at ${routing.caddy_admin_url} (bootstrapped)`
            : `[pass] caddy ready at ${routing.caddy_admin_url}`,
        );
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (!tailscale.enabled) {
    console.log("[skip] tailscale disabled");
  } else if (is_proxy_tailscale_mode(tailscale.mode)) {
    if (!tailscale.connected || !tailscale.ipv4 || !tailscale.node_id) {
      issues.push(
        tailscale.error ?? "Tailscale proxy mode requires a connected client with an IPv4 address",
      );
    } else if (instance) {
      try {
        const dns_resolutions = await Promise.all(
          Object.values(instance.endpoints).map((endpoint) =>
            validate_tailscale_hostname(endpoint.public_hostname, tailscale.ipv4!),
          ),
        );
        const routing = resolve_routing(loaded_config.config);
        const serve_port = get_tailscale_serve_port(loaded_config);

        console.log(
          dns_resolutions.every((resolution) => resolution === "tailnet")
            ? `[pass] ${dns_resolutions.length} tailnet endpoint hostname(s) -> ${tailscale.ipv4}`
            : `[pass] ${dns_resolutions.length} local endpoint hosts entry or entries -> loopback; remote machines must map them to ${tailscale.ipv4}`,
        );

        if (!routing_ready) {
          issues.push(
            "Tailscale Serve was not checked because the configured routing provider is not ready",
          );
        } else if (fix) {
          const active_routing = ensure_tailscale_serve({
            instance,
            tailscale,
            routing_port: routing.port,
            serve_port,
          });

          console.log(
            `[pass] tailscale Serve tcp:${serve_port} -> ${active_routing.mapping_target} (reconciled)`,
          );
        } else {
          const inspection = inspect_tailscale_serve({
            instance,
            tailscale,
            routing_port: routing.port,
            serve_port,
          });

          if (!inspection.matches) {
            issues.push(
              `Tailscale Serve port ${serve_port} must forward raw TCP to tcp://${inspection.target}; found ${describe_tailscale_serve_status(inspection.status)}. Run \`pnpm devtree doctor --fix\`.`,
            );
          } else {
            console.log(`[pass] tailscale Serve tcp:${serve_port} -> ${inspection.target}`);
          }
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (tailscale.mode === "direct" && tailscale.host) {
    console.log(`[pass] tailscale host ${tailscale.host}`);
  } else {
    issues.push(tailscale.error ?? "tailscale is enabled, but is not connected");
  }

  if (is_proxy_tailscale_mode(tailscale.mode)) {
    console.log("[pass] Vite host 127.0.0.1 (proxy mode)");
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
  const configured_tailscale_port = is_proxy_tailscale_mode(runtime_state.tailscale.mode)
    ? get_tailscale_serve_port(runtime_state.loaded_config)
    : resolve_routing(runtime_state.loaded_config.config).port;

  for (const line of format_routing_info_lines({
    instance: runtime_state.instance,
    tailscale_mode: runtime_state.tailscale.mode,
    active_tailscale_routing: runtime_state.active_tailscale_routing,
    configured_tailscale_port,
  })) {
    console.log(line);
  }

  console.log(`Project: ${runtime_state.instance.project_name}`);
  console.log(`Session: ${runtime_state.instance.session_name}`);
  console.log(
    `Dependencies: ${runtime_state.instance.dependencies.owns ? "self" : runtime_state.instance.dependency_owner}`,
  );
  console.log(`Instance ID: ${runtime_state.instance.instance_id}`);
  console.log(`Scoped name: ${runtime_state.instance.scoped_name}`);
  console.log(`Worktree path: ${runtime_state.instance.worktree_path}`);
  console.log(`Branch: ${runtime_state.instance.branch_name ?? "detached"}`);
  console.log(`Routing provider: ${runtime_state.instance.routing_provider}`);
  console.log(`Routing enabled: ${runtime_state.instance.routing_enabled ? "yes" : "no"}`);
  console.log(`Portless enabled: ${runtime_state.instance.portless_enabled ? "yes" : "no"}`);
  console.log(
    `Environment registry: ${runtime_state.loaded_config.config.registry?.enabled === false ? "disabled" : "enabled"}`,
  );
  console.log(`Tailscale mode: ${runtime_state.tailscale.mode}`);
  console.log(`Env provider: ${runtime_state.loaded_config.config.env.provider}`);
  console.log(`Env file: ${runtime_state.instance.env_file_path}`);

  for (const endpoint of Object.values(runtime_state.instance.endpoints)) {
    console.log(
      `Endpoint (${endpoint.name}${endpoint.primary ? ", primary" : ""}): ${endpoint.public_url} -> ${endpoint.target_host}:${endpoint.target_port}`,
    );
  }

  if (runtime_state.tailscale.mode === "direct") {
    console.log(`Tailscale host: ${runtime_state.tailscale.host ?? "unavailable"}`);
  }

  for (const dependency of get_compose_dependencies(runtime_state.loaded_config)) {
    const compose_project = resolve_compose_project_name(
      dependency,
      get_command_context(runtime_state),
    );
    console.log(`Compose project (${dependency.name}): ${compose_project}`);
  }
}

function get_missing_dependency_names(runtime_state: Runtime_state) {
  const registered_names = new Set(
    list_registered_compose_projects(
      runtime_state.instance.project_name,
      runtime_state.instance.dependency_owner,
    ).map((entry) => entry.dependency_name),
  );

  return get_compose_dependencies(runtime_state.loaded_config)
    .map((dependency) => dependency.name)
    .filter((name) => !registered_names.has(name));
}

function assert_reusable_dependencies(runtime_state: Runtime_state) {
  if (runtime_state.instance.dependencies.owns) {
    return;
  }

  const command_dependency = runtime_state.loaded_config.config.dependencies?.find(
    (dependency) => dependency.kind === "command",
  );

  if (command_dependency) {
    throw new Error(
      `Dependency "${command_dependency.name}" is command-based and cannot be reused. Start this session with -d.`,
    );
  }

  const missing_names = get_missing_dependency_names(runtime_state);

  if (missing_names.length > 0) {
    throw new Error(
      `Dependency stack "${runtime_state.instance.project_name}/${runtime_state.instance.dependency_owner}" is not initialized (${missing_names.join(", ")}). Start its owner session or use -d.`,
    );
  }
}

function run_dependency_action(runtime_state: Runtime_state, action: "logs" | "start" | "stop") {
  if (!runtime_state.instance.dependencies.owns) {
    if (action !== "logs") {
      throw new Error(
        `Session "${runtime_state.instance.session_name}" reuses dependencies from "${runtime_state.instance.dependency_owner}" and cannot ${action} that stack.`,
      );
    }

    const command_dependency = runtime_state.loaded_config.config.dependencies?.find(
      (dependency) => dependency.kind === "command",
    );

    if (command_dependency) {
      throw new Error(
        `Dependency "${command_dependency.name}" is command-based and cannot be reused or inspected from a consumer session.`,
      );
    }
  }

  if (action === "stop") {
    assert_dependency_stack_idle(runtime_state, "stop");
  }

  for (const dependency of runtime_state.loaded_config.config.dependencies ?? []) {
    if (dependency.kind === "compose") {
      run_compose_dependency(runtime_state, dependency, action);
      continue;
    }

    const command_spec =
      action === "start" ? dependency.start : action === "stop" ? dependency.stop : dependency.logs;

    if (command_spec) {
      run_command_spec(runtime_state, command_spec);
    }
  }
}

function assert_dependency_stack_idle(
  runtime_state: Runtime_state,
  action: "run setup or migrations for" | "stop",
) {
  const live_sessions = list_dependency_stack_sessions(
    runtime_state.instance.project_name,
    runtime_state.instance.dependency_owner,
  );

  if (live_sessions.length === 0) {
    return;
  }

  const names = live_sessions.map((session) => session.session_name).join(", ");
  throw new Error(
    `Cannot ${action} dependency stack "${runtime_state.instance.project_name}/${runtime_state.instance.dependency_owner}" while used by live session(s): ${names}.`,
  );
}

function prepare_dev_dependencies(runtime_state: Runtime_state) {
  if (!runtime_state.instance.dependencies.owns) {
    assert_reusable_dependencies(runtime_state);
    return;
  }

  const was_initialized = get_missing_dependency_names(runtime_state).length === 0;

  run_dependency_action(runtime_state, "start");

  if (!was_initialized) {
    run_hook(runtime_state, "setup");
    run_hook(runtime_state, "migrate");
    run_hook(runtime_state, "post_setup");
  }
}

async function register_endpoint_routes(runtime_state: Runtime_state) {
  const routing = resolve_routing(runtime_state.loaded_config.config);
  const cleanups: Array<() => Promise<void> | void> = [];

  async function cleanup_registered_routes() {
    const pending_cleanups = cleanups.splice(0).reverse();
    let first_error: unknown;

    for (const cleanup of pending_cleanups) {
      try {
        await cleanup();
      } catch (error) {
        first_error ??= error;
      }
    }

    if (first_error) {
      throw first_error;
    }
  }

  if (!routing.enabled) {
    return async () => {};
  }

  try {
    for (const endpoint of Object.values(runtime_state.instance.endpoints)) {
      if (routing.provider_kind === "portless") {
        const result = run_command_capture(
          "portless",
          get_portless_alias_add_args(endpoint.public_hostname, endpoint.target_port),
          { allow_failure: true },
        );

        if (result.status !== 0) {
          throw new Error(
            `Could not register Portless route ${endpoint.public_hostname}: ${result.stderr || result.stdout}`,
          );
        }

        cleanups.push(() => {
          run_command_capture(
            "portless",
            get_portless_alias_remove_args(endpoint.public_hostname),
            { allow_failure: true },
          );
        });
        continue;
      }

      if (!routing.caddy_admin_url) {
        throw new Error("Caddy routing requires a local admin URL.");
      }

      const route_id = get_caddy_route_id(`${runtime_state.instance.instance_id}-${endpoint.name}`);

      await register_caddy_route(
        routing.caddy_admin_url,
        create_caddy_route({
          route_id,
          hostname: endpoint.public_hostname,
          upstream_port: endpoint.target_port,
        }),
      );
      cleanups.push(() => remove_caddy_route(routing.caddy_admin_url!, route_id));
    }
  } catch (error) {
    try {
      await cleanup_registered_routes();
    } catch (cleanup_error) {
      console.warn(
        `[devtree] Could not roll back every endpoint route: ${cleanup_error instanceof Error ? cleanup_error.message : String(cleanup_error)}`,
      );
    }

    throw error;
  }

  return cleanup_registered_routes;
}

async function main() {
  const argv = process.argv.slice(2);
  const command_name = get_command_name(argv);

  if (command_name === "help") {
    print_help();
    return;
  }

  if (command_name === "env") {
    const output_flags = argv.filter((arg) => arg === "--json" || arg === "--shell");
    if (output_flags.includes("--json") && output_flags.includes("--shell"))
      throw new Error("Choose either --json or --shell.");
    if (["write", "show"].includes(argv[1]) && output_flags.length)
      throw new Error("Output flags are supported by devtree env without a write/show subcommand.");
  }

  if (command_name === "list") {
    const list_args = argv.slice(1);

    if (list_args.some((arg) => arg !== "--json")) {
      throw new Error("Usage: devtree list [--json]");
    }

    const sessions = list_environment_sessions();
    console.log(
      list_args.includes("--json")
        ? format_environment_list_json(sessions)
        : format_environment_list(sessions),
    );
    return;
  }

  if (command_name === "upgrade") {
    if (argv.length !== 1) {
      throw new Error("Usage: devtree upgrade");
    }

    const { config_path, repo_root } = find_devtree_config();
    const { run_upgrade_command } = await import("./upgrade.ts");
    await run_upgrade_command(repo_root, config_path);
    return;
  }

  if (command_name === "mise") {
    if (argv.length !== 2 || argv[1] !== "install") throw new Error("Usage: devtree mise install");
    const { install_mise_adapter } = await import("./mise.ts");
    install_mise_adapter();
    return;
  }

  if (command_name === "setup" && (argv.includes("--interactive") || argv.includes("-i"))) {
    const { run_interactive_setup } = await import("./interactive-setup.ts");
    await run_interactive_setup(
      process.cwd(),
      argv.slice(1).filter((arg) => arg !== "-i" && arg !== "--interactive"),
    );
    return;
  }

  if (command_name === "session" && argv[1] === "remove" && argv[2] && !argv[2].startsWith("-")) {
    if (argv.length !== 3) throw new Error("Usage: devtree session remove <session-id>");
    remove_environment_session(argv[2]);
    console.log(`Removed session ${argv[2]}.`);
    return;
  }

  const loaded_config = await load_devtree_config();

  if (command_name === "doctor") {
    await run_doctor(loaded_config, argv.includes("--fix"));
    return;
  }

  if (command_name === "config") {
    const { format_config_value, get_config_value, set_config_value } =
      await import("./config-command.ts");
    const config_key = argv[1];

    if (!config_key) {
      throw new Error("Usage: devtree config <key.path> [value]");
    }

    if (argv.length === 2) {
      console.log(format_config_value(get_config_value(loaded_config.config, config_key)));
      return;
    }

    set_config_value(loaded_config.config_path, config_key, argv.slice(2).join(" "));

    const updated_config = await load_devtree_config();
    console.log(
      `${config_key} = ${format_config_value(get_config_value(updated_config.config, config_key))}`,
    );
    return;
  }

  if (command_name === "hosts") {
    const parsed_options = parse_session_options(argv.slice(1));

    if (parsed_options.interactive) {
      throw new Error("Interactive session selection is available through `devtree dev -i`.");
    }

    const instance = await resolve_session_instance(loaded_config, parsed_options);

    if (!instance) {
      return;
    }

    const public_hostnames = Object.values(instance.endpoints)
      .map((endpoint) => endpoint.public_hostname)
      .filter((hostname) => !is_localhost_hostname(hostname));

    if (public_hostnames.length === 0) {
      console.log(
        "Every endpoint uses a local-only hostname and does not need a hosts-file entry.",
      );
      console.log(
        "Configure routing.hostname with a custom domain before sharing the application with another machine.",
      );
      return;
    }

    console.log(format_local_hosts_section(public_hostnames));
    console.log("");
    console.log(format_tailscale_hosts_section(public_hostnames, resolve_tailscale_ipv4()));
    return;
  }

  if (command_name === "session") {
    if (argv[1] !== "remove") throw new Error("Usage: devtree session remove [--name NAME]");
    const options = parse_session_options(argv.slice(2));
    if (
      options.interactive ||
      options.dependency_owner ||
      options.own_dependencies ||
      options.passthrough_args.length
    )
      throw new Error("Usage: devtree session remove [--name NAME]");
    const instance = create_devtree_instance(loaded_config, options);
    const session = options.session_name
      ? list_environment_sessions().find(
          (entry) =>
            entry.instance_id === instance.instance_id &&
            entry.worktree_path === instance.worktree_path,
        )
      : (get_selected_environment_session(instance.project_name, instance.worktree_path) ??
        list_environment_sessions().find(
          (entry) =>
            entry.instance_id === instance.instance_id &&
            entry.worktree_path === instance.worktree_path,
        ));
    if (!session) throw new Error("No saved session matches this checkout and name.");
    remove_environment_session(session.session_id);
    console.log(`Removed session ${session.project_name}/${session.session_name}.`);
    return;
  }

  let resolved_instance: Devtree_instance | null = null;
  let dev_passthrough_args: string[] = [];

  if (["dev", "info", "setup", "deps", "env", "exec"].includes(command_name)) {
    const env_subcommand = command_name === "env" && ["write", "show"].includes(argv[1]);
    const option_args = argv
      .slice(command_name === "deps" || env_subcommand ? 2 : 1)
      .filter((arg) => command_name !== "env" || (arg !== "--json" && arg !== "--shell"));
    const parsed_options = parse_session_options(
      command_name === "setup"
        ? option_args.filter((arg) => arg !== "-i" && arg !== "--interactive")
        : option_args,
    );

    if (command_name !== "dev" && parsed_options.interactive) {
      throw new Error("Interactive session selection is available through `devtree dev -i`.");
    }

    if (
      command_name !== "dev" &&
      command_name !== "exec" &&
      parsed_options.passthrough_args.length > 0
    ) {
      throw new Error("Arguments after -- are only supported by dev and exec.");
    }
    dev_passthrough_args = parsed_options.passthrough_args;
    resolved_instance = await resolve_session_instance(loaded_config, parsed_options);

    if (!resolved_instance) {
      return;
    }
  }

  const runtime_state = get_runtime_state(
    loaded_config,
    resolved_instance ??
      (await resolve_session_instance(loaded_config, parse_session_options([])))!,
  );

  if (command_name === "info") {
    print_info(runtime_state);
    return;
  }

  if (command_name === "exec") {
    if (dev_passthrough_args.length === 0) {
      throw new Error("Usage: devtree exec [session options] -- <command> [args]");
    }
    const command_parts =
      loaded_config.config.env.provider === "varlock"
        ? with_varlock(dev_passthrough_args)
        : dev_passthrough_args;
    const [command, ...args] = command_parts;
    process.exitCode = await run_command_inherit_async(command, args, {
      cwd: loaded_config.repo_root,
      env: create_runtime_env(
        runtime_state.instance,
        runtime_state.effective_env_values,
        runtime_state.tailscale,
        undefined,
        runtime_state.active_tailscale_routing,
      ),
    });
    return;
  }

  if (command_name === "tailscale") {
    const tailscale_subcommand = argv[1];

    if (tailscale_subcommand !== "status" && tailscale_subcommand !== "remove") {
      throw new Error("Usage: devtree tailscale <status|remove>");
    }

    ensure_proxy_mode_configuration(loaded_config, runtime_state.instance);

    if (!is_proxy_tailscale_mode(runtime_state.tailscale.mode)) {
      throw new Error(
        'The `devtree tailscale` command requires tailscale.enabled: true and tailscale.mode: "proxy".',
      );
    }

    require_proxy_tailscale(runtime_state);

    const routing = resolve_routing(loaded_config.config);
    const serve_port = get_tailscale_serve_port(loaded_config);

    if (tailscale_subcommand === "status") {
      const inspection = inspect_tailscale_serve({
        instance: runtime_state.instance,
        tailscale: runtime_state.tailscale,
        routing_port: routing.port,
        serve_port,
      });

      console.log(`Tailscale Serve port: ${serve_port}`);
      console.log(`Required mapping: tcp:${serve_port} -> ${inspection.target}`);
      console.log(`Live mapping: ${describe_tailscale_serve_status(inspection.status)}`);
      console.log(`Ready: ${inspection.matches ? "yes" : "no"}`);
      console.log(
        `Ownership: ${inspection.persisted_mapping?.owned ? "Devtree" : "not owned by Devtree"}`,
      );
      console.log(
        `Recorded sessions: ${inspection.persisted_mapping?.consumer_instance_ids.length ?? 0}`,
      );
      return;
    }

    const removal = remove_owned_tailscale_serve({
      instance: runtime_state.instance,
      tailscale: runtime_state.tailscale,
      routing_port: routing.port,
      serve_port,
    });

    console.log(
      removal.removed
        ? `Removed Devtree's Tailscale Serve mapping on TCP port ${serve_port}. Other Serve ports were preserved.`
        : `Tailscale Serve port ${serve_port} was already absent. Removed stale Devtree ownership state.`,
    );
    return;
  }

  if (command_name === "env") {
    const env_subcommand = argv[1];

    if (env_subcommand === "write") {
      sync_runtime_env(runtime_state);
      return;
    }

    if (env_subcommand === "show") {
      print_info(runtime_state);
      return;
    }

    if (argv.includes("--json") && argv.includes("--shell"))
      throw new Error("Choose either --json or --shell.");
    const managed_values = Object.fromEntries(
      Object.keys(runtime_state.managed_env_values).map((key) => [
        key,
        runtime_state.effective_env_values[key],
      ]),
    );
    const values = create_runtime_env(
      runtime_state.instance,
      managed_values,
      runtime_state.tailscale,
      undefined,
      runtime_state.active_tailscale_routing,
    );
    console.log(
      format_env_export(
        values,
        argv.includes("--json") ? "json" : argv.includes("--shell") ? "shell" : "plain",
      ),
    );
    return;
  }

  if (command_name === "gc") {
    run_gc(loaded_config, runtime_state.instance, {
      dry_run: argv.includes("--dry-run"),
      verbose: argv.includes("--verbose") || argv.includes("-v"),
    });
    return;
  }

  if (command_name === "setup") {
    if (!runtime_state.instance.dependencies.owns) {
      throw new Error(
        `Session "${runtime_state.instance.session_name}" reuses dependencies from "${runtime_state.instance.dependency_owner}". Run setup from the owner or start an isolated session with devtree dev -d.`,
      );
    }

    assert_dependency_stack_idle(runtime_state, "run setup or migrations for");
    sync_runtime_env(runtime_state);

    ensure_proxy_mode_configuration(loaded_config, runtime_state.instance);
    await ensure_routing_ready(loaded_config);
    await ensure_tailscale_proxy_ready(runtime_state);
    print_tailscale_status(runtime_state);

    run_dependency_action(runtime_state, "start");

    run_hook(runtime_state, "setup");
    run_hook(runtime_state, "migrate");
    run_hook(runtime_state, "post_setup");

    print_application_urls(runtime_state);
    console.log("Start the application before opening the URL above.");
    if (runtime_state.tailscale.mode === "direct" && runtime_state.tailscale.host) {
      console.log(`Tailscale hostname available to Vite: ${runtime_state.tailscale.host}`);
    }
    console.log("Run `pnpm devtree dev` to launch the session's dev server.");
    return;
  }

  if (command_name === "deps") {
    const deps_subcommand = argv[1];

    if (deps_subcommand !== "start" && deps_subcommand !== "stop" && deps_subcommand !== "logs") {
      throw new Error("Usage: devtree deps <start|stop|logs>");
    }

    run_dependency_action(runtime_state, deps_subcommand);

    return;
  }

  if (command_name === "dev") {
    const routing = resolve_routing(loaded_config.config);

    if (
      routing.provider_kind === "portless" &&
      !runtime_state.instance.portless_enabled &&
      !process.env.BETTER_AUTH_URL
    ) {
      console.warn(
        "PORTLESS=0 disables the injected public URL. Set BETTER_AUTH_URL before signing in.",
      );
    }

    const dev_server_endpoint = Object.values(runtime_state.instance.endpoints).find(
      (endpoint) => endpoint.target_kind === "dev-server",
    );

    if (!dev_server_endpoint) {
      throw new Error("No dev-server endpoint was resolved.");
    }

    const development_command = build_development_command({
      extra_args: dev_passthrough_args,
      routing_provider: routing.provider_kind,
      runner: get_dev_server_runner(loaded_config),
      vite_host: "127.0.0.1",
      vite_port: dev_server_endpoint.target_port,
      use_varlock: loaded_config.config.env.provider === "varlock",
    });
    const [command, ...args] = development_command;

    let exit_status = 0;
    let cleanup_routes: () => Promise<void> = async () => {};

    const environment_session = create_environment_session(runtime_state.instance);

    try {
      await assert_dev_server_port_available(dev_server_endpoint);
      sync_runtime_env(runtime_state);
      prepare_dev_dependencies(runtime_state);
      ensure_proxy_mode_configuration(loaded_config, runtime_state.instance);
      await ensure_routing_ready(loaded_config);
      await ensure_tailscale_proxy_ready(runtime_state);
      print_tailscale_status(runtime_state);
      run_hook(runtime_state, "pre_dev");

      cleanup_routes = await register_endpoint_routes(runtime_state);
      console.log(`[devtree] Session ${runtime_state.instance.session_name}`);
      console.log(`[devtree] Instance ${runtime_state.instance.instance_id}`);
      print_application_urls(runtime_state);

      const runtime_env = create_runtime_env(
        runtime_state.instance,
        runtime_state.effective_env_values,
        runtime_state.tailscale,
        routing.provider_kind === "portless"
          ? {
              PORTLESS_PORT: String(routing.port),
              PORTLESS_HTTPS: routing.https ? "1" : "0",
            }
          : undefined,
        runtime_state.active_tailscale_routing,
      );

      exit_status = await run_command_inherit_async(command, args, {
        cwd: loaded_config.repo_root,
        env: {
          ...runtime_env,
          __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: dev_server_endpoint.public_hostname,
        },
        on_spawn: (runner_pid) => {
          try {
            set_environment_session_runner_pid(environment_session, runner_pid);
          } catch (error) {
            console.warn(
              `[devtree] Could not update this environment's registry entry: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      });
    } finally {
      try {
        await cleanup_routes();
      } finally {
        try {
          stop_environment_session(environment_session.session_id);
        } catch (error) {
          console.warn(
            `[devtree] Could not mark the session stopped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (exit_status !== 0) {
      process.exitCode = exit_status;
    }
    return;
  }

  throw new Error("Unknown command.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
