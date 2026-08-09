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
import { load_devtree_config } from "./config.ts";
import { format_config_value, get_config_value, set_config_value } from "./config-command.ts";
import {
  build_development_command,
  get_dev_server_command,
  type Dev_server_runner,
} from "./command-builder.ts";
import {
  get_proxy_mode_configuration_error,
  is_proxy_tailscale_mode,
} from "./doctor.ts";
import { ensure_env_file, get_env_file_status_message } from "./env-file.ts";
import { run_gc } from "./gc.ts";
import {
  format_local_hosts_section,
  format_tailscale_hosts_section,
  is_localhost_hostname,
  resolve_tailscale_ipv4,
} from "./hosts.ts";
import { create_devtree_instance, type Devtree_instance } from "./instance.ts";
import { format_routing_info_lines } from "./info.ts";
import { run_interactive_setup } from "./interactive-setup.ts";
import { resolve_portless_https, resolve_portless_port } from "./hostname.ts";
import { get_portless_compatibility_error } from "./portless.ts";
import {
  command_exists,
  run_command_capture,
  run_command_inherit,
  run_command_inherit_async,
  type Run_command_options,
} from "./process.ts";
import { register_compose_project } from "./registry.ts";
import {
  get_persisted_active_tailscale_routing,
  type Active_tailscale_routing,
} from "./routing-state.ts";
import { has_configured_routing_hostname, resolve_routing } from "./routing.ts";
import { create_runtime_env } from "./runtime-env.ts";
import { resolve_tailscale, type Resolved_tailscale } from "./tailscale.ts";
import { validate_tailscale_hostname } from "./tailscale-dns.ts";
import {
  describe_tailscale_serve_status,
  ensure_tailscale_serve,
  inspect_tailscale_serve,
  remove_owned_tailscale_serve,
  resolve_tailscale_serve_port,
} from "./tailscale-serve.ts";

type Command_name =
  | "config"
  | "deps"
  | "dev"
  | "doctor"
  | "env"
  | "gc"
  | "help"
  | "hosts"
  | "info"
  | "setup"
  | "tailscale";

type Runtime_state = {
  loaded_config: Loaded_devtree_config;
  instance: Devtree_instance;
  env_status_message: string;
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
  console.log("  info                    Print the current instance URLs and resource names");
  console.log("  tailscale status|remove Inspect or safely remove Devtree's Serve mapping");
  console.log("  hosts                   Print hosts-file entries for this checkout");
  console.log("  setup [--interactive]   Configure Devtree, sync env, and start dependencies");
  console.log("  dev [-- <vite args>]    Start the app through Devtree routing");
  console.log("  deps start|stop|logs    Manage configured dependencies");
  console.log("  gc [--dry-run] [-v]     Remove orphaned dependency resources");
  console.log("  env write|show          Compatibility aliases for env sync and info");
}

function get_command_name(argv: string[]) {
  return (argv[0] as Command_name | undefined) ?? "help";
}

function get_portless_start_args(loaded_config: Loaded_devtree_config) {
  const args = [
    "proxy",
    "start",
    "--port",
    String(resolve_portless_port(loaded_config.config)),
  ];

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
    cwd: options?.cwd,
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

function get_runtime_state(loaded_config: Loaded_devtree_config) {
  const instance = create_devtree_instance(loaded_config);
  const env_result = ensure_env_file(loaded_config, instance);
  const tailscale = resolve_tailscale(loaded_config.config);
  const persisted_tailscale_routing =
    get_persisted_active_tailscale_routing(instance);
  const active_tailscale_routing =
    tailscale.node_id &&
    persisted_tailscale_routing &&
    !persisted_tailscale_routing.mapping_key.startsWith(`${tailscale.node_id}:`)
      ? null
      : persisted_tailscale_routing;

  return {
    loaded_config,
    instance,
    env_status_message: get_env_file_status_message(env_result),
    managed_env_values: env_result.managed_env_values,
    effective_env_values: env_result.effective_env_values,
    tailscale,
    active_tailscale_routing,
  };
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
  const routing = resolve_routing(loaded_config.config);

  if (routing.provider_kind !== "portless" || !routing.enabled) {
    return;
  }

  if (!command_exists("portless")) {
    throw new Error(
      "Devtree requires `portless`, but it was not found on PATH. Install it or run with PORTLESS=0.",
    );
  }

  if (has_configured_routing_hostname(loaded_config.config)) {
    const help_result = run_command_capture("portless", ["run", "--help"], {
      allow_failure: true,
    });
    const compatibility_error = get_portless_compatibility_error(
      `${help_result.stdout}\n${help_result.stderr}`,
    );

    if (compatibility_error) {
      throw new Error(compatibility_error);
    }
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

async function ensure_routing_ready(
  loaded_config: Loaded_devtree_config,
  should_fix = true,
) {
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

  return resolve_tailscale_serve_port(
    loaded_config.config.tailscale?.serve_port,
    routing.port,
  );
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

  await validate_tailscale_hostname(
    runtime_state.instance.public_hostname,
    runtime_state.tailscale.ipv4 as string,
  );

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

    return;
  }

  console.log(`Open ${runtime_state.instance.public_url}`);
}

function resolve_require_from_root(repo_root: string) {
  return createRequire(resolve(repo_root, "package.json"));
}

function get_dev_server_runner(loaded_config: Loaded_devtree_config): Dev_server_runner {
  const runner = loaded_config.config.dev_server?.runner as string | undefined;

  if (runner === undefined || runner === "vite-plus" || runner === "vite") {
    return runner ?? "vite-plus";
  }

  throw new Error('dev_server.runner must be "vite-plus" or "vite".');
}

function ensure_proxy_mode_configuration(
  loaded_config: Loaded_devtree_config,
  instance: Devtree_instance,
) {
  const configuration_error = get_proxy_mode_configuration_error(
    loaded_config.config,
    instance,
  );

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
    instance = create_devtree_instance(loaded_config);
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
          console.log(
            fix ? "[pass] portless ready (bootstrapped)" : "[pass] portless reachable",
          );
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
        tailscale.error ??
          "Tailscale proxy mode requires a connected client with an IPv4 address",
      );
    } else if (instance) {
      try {
        const dns_resolution = await validate_tailscale_hostname(
          instance.public_hostname,
          tailscale.ipv4,
        );
        const routing = resolve_routing(loaded_config.config);
        const serve_port = get_tailscale_serve_port(loaded_config);

        console.log(
          dns_resolution === "tailnet"
            ? `[pass] tailnet hostname ${instance.public_hostname} -> ${tailscale.ipv4}`
            : `[pass] local hosts entry ${instance.public_hostname} -> loopback; remote machines must map it to ${tailscale.ipv4}`,
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
            console.log(
              `[pass] tailscale Serve tcp:${serve_port} -> ${inspection.target}`,
            );
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
  const configured_tailscale_port = is_proxy_tailscale_mode(
    runtime_state.tailscale.mode,
  )
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

  console.log(`App name: ${runtime_state.instance.app_name}`);
  console.log(`Instance ID: ${runtime_state.instance.instance_id}`);
  console.log(`Scoped name: ${runtime_state.instance.scoped_name}`);
  console.log(`Worktree path: ${runtime_state.instance.worktree_path}`);
  console.log(`Worktree slug: ${runtime_state.instance.worktree_slug ?? "main checkout"}`);
  console.log(`Routing provider: ${runtime_state.instance.routing_provider}`);
  console.log(`Routing enabled: ${runtime_state.instance.routing_enabled ? "yes" : "no"}`);
  console.log(`Portless enabled: ${runtime_state.instance.portless_enabled ? "yes" : "no"}`);
  console.log(`Tailscale mode: ${runtime_state.tailscale.mode}`);
  console.log(`Env provider: ${runtime_state.loaded_config.config.env.provider}`);
  console.log(`Env file: ${runtime_state.instance.env_file_path}`);

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

async function main() {
  const argv = process.argv.slice(2);
  const command_name = get_command_name(argv);

  if (command_name === "help") {
    print_help();
    return;
  }

  let loaded_config = await load_devtree_config();

  if (
    command_name === "setup" &&
    (argv.includes("--interactive") || argv.includes("-i"))
  ) {
    const setup_result = await run_interactive_setup(loaded_config);

    if (!setup_result.configured) {
      return;
    }

    if (!setup_result.continue_setup) {
      return;
    }

    loaded_config = await load_devtree_config();
  }

  if (command_name === "doctor") {
    await run_doctor(loaded_config, argv.includes("--fix"));
    return;
  }

  if (command_name === "config") {
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
    const instance = create_devtree_instance(loaded_config);

    if (is_localhost_hostname(instance.public_hostname)) {
      console.log(
        `${instance.public_hostname} is a local-only hostname and does not need a hosts-file entry.`,
      );
      console.log(
        "Configure routing.hostname with a custom domain before sharing the application with another machine.",
      );
      return;
    }

    console.log(format_local_hosts_section(instance.public_hostname));
    console.log("");
    console.log(
      format_tailscale_hosts_section(
        instance.public_hostname,
        resolve_tailscale_ipv4(),
      ),
    );
    return;
  }

  const runtime_state = get_runtime_state(loaded_config);

  if (command_name === "info") {
    console.log(runtime_state.env_status_message);
    print_info(runtime_state);
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
        `Recorded worktrees: ${inspection.persisted_mapping?.consumer_instance_ids.length ?? 0}`,
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
      console.log(runtime_state.env_status_message);
      return;
    }

    if (env_subcommand === "show") {
      print_info(runtime_state);
      return;
    }

    throw new Error("Usage: devtree env <write|show>");
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
    ensure_proxy_mode_configuration(loaded_config, runtime_state.instance);
    await ensure_routing_ready(loaded_config);
    await ensure_tailscale_proxy_ready(runtime_state);
    print_tailscale_status(runtime_state);

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

    print_application_urls(runtime_state);
    console.log("Start the application before opening the URL above.");
    if (runtime_state.tailscale.mode === "direct" && runtime_state.tailscale.host) {
      console.log(`Tailscale hostname available to Vite: ${runtime_state.tailscale.host}`);
    }
    console.log("Run `pnpm devtree dev` to launch the worktree-scoped dev server.");
    return;
  }

  if (command_name === "deps") {
    const deps_subcommand = argv[1];

    if (deps_subcommand !== "start" && deps_subcommand !== "stop" && deps_subcommand !== "logs") {
      throw new Error("Usage: devtree deps <start|stop|logs>");
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

    ensure_proxy_mode_configuration(loaded_config, runtime_state.instance);
    await ensure_routing_ready(loaded_config);
    await ensure_tailscale_proxy_ready(runtime_state);
    print_tailscale_status(runtime_state);
    run_hook(runtime_state, "pre_dev");

    const vite_port =
      routing.provider_kind === "caddy"
        ? runtime_state.instance.allocate_port("vite", 5173)
        : undefined;
    const caddy_route_id =
      routing.provider_kind === "caddy"
        ? get_caddy_route_id(runtime_state.instance.instance_id)
        : null;
    const development_command = build_development_command({
      app_name: runtime_state.instance.app_name,
      public_hostname: runtime_state.instance.public_hostname,
      portless_exact_hostname: has_configured_routing_hostname(loaded_config.config),
      extra_args,
      portless_enabled: runtime_state.instance.portless_enabled,
      routing_provider: routing.provider_kind,
      runner: get_dev_server_runner(loaded_config),
      vite_host:
        routing.provider_kind === "portless" &&
        runtime_state.tailscale.mode === "direct" &&
        runtime_state.tailscale.host
          ? "0.0.0.0"
          : "127.0.0.1",
      vite_port,
      use_varlock: loaded_config.config.env.provider === "varlock",
    });
    const [command, ...args] = development_command;

    if (
      routing.provider_kind === "caddy" &&
      routing.caddy_admin_url &&
      vite_port !== undefined &&
      caddy_route_id
    ) {
      await register_caddy_route(
        routing.caddy_admin_url,
        create_caddy_route({
          route_id: caddy_route_id,
          hostname: runtime_state.instance.public_hostname,
          upstream_port: vite_port,
        }),
      );
      console.log(
        `[devtree] Caddy route ${runtime_state.instance.public_hostname} -> 127.0.0.1:${vite_port}`,
      );
    }

    print_application_urls(runtime_state);

    let exit_status = 0;

    try {
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

      exit_status =
        routing.provider_kind === "caddy"
          ? await run_command_inherit_async(command, args, { env: runtime_env })
          : run_command_inherit(command, args, { env: runtime_env });
    } finally {
      if (routing.provider_kind === "caddy" && routing.caddy_admin_url && caddy_route_id) {
        await remove_caddy_route(routing.caddy_admin_url, caddy_route_id);
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
