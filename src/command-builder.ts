import type { Routing_provider_kind } from "./routing.ts";

export function strip_passthrough_delimiter(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

export type Dev_server_runner = "vite-plus" | "vite" | { kind: "mise"; task: string };

export function get_dev_server_command(runner: Dev_server_runner) {
  if (typeof runner === "object") return "mise";
  return runner === "vite" ? "vite" : "vp";
}

export function build_vite_dev_command(
  extra_args: string[],
  host = "127.0.0.1",
  runner: Dev_server_runner = "vite-plus",
  port?: number,
) {
  return [
    ...(typeof runner === "object"
      ? ["mise", "run", runner.task, "--"]
      : [get_dev_server_command(runner), "dev"]),
    "--host",
    host,
    "--clearScreen",
    "false",
    ...extra_args,
    ...(port === undefined ? [] : ["--port", String(port), "--strictPort"]),
  ];
}

export function build_varlock_command(command_parts: string[]) {
  return ["varlock", "run", "--", ...command_parts];
}

export function build_development_command(options: {
  extra_args: string[];
  routing_provider?: Routing_provider_kind;
  runner?: Dev_server_runner;
  vite_host?: string;
  vite_port?: number;
  use_varlock: boolean;
}) {
  const routing_provider = options.routing_provider ?? "portless";
  const reserved_option = options.extra_args.find((argument) =>
    /^--(?:host|port|strictPort|clearScreen)(?:=|$)/u.test(argument),
  );
  if (reserved_option)
    throw new Error(`${reserved_option} is managed by Devtree and cannot be overridden.`);

  if (routing_provider === "caddy" && options.vite_port === undefined) {
    throw new Error("A fixed Vite port is required when Caddy routing is enabled.");
  }

  if (
    routing_provider === "caddy" &&
    options.vite_host !== undefined &&
    options.vite_host !== "127.0.0.1"
  ) {
    throw new Error("Caddy routing requires Vite to stay on 127.0.0.1.");
  }

  let command_parts = build_vite_dev_command(
    strip_passthrough_delimiter(options.extra_args),
    options.vite_host,
    options.runner,
    options.vite_port,
  );

  if (options.use_varlock) {
    command_parts = build_varlock_command(command_parts);
  }

  return command_parts;
}
