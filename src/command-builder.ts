import { PORTLESS_EXACT_HOSTNAME_FLAG } from "./portless.ts";

export function strip_passthrough_delimiter(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

export type Dev_server_runner = "vite-plus" | "vite";

export function get_dev_server_command(runner: Dev_server_runner) {
  return runner === "vite" ? "vite" : "vp";
}

export function build_vite_dev_command(
  extra_args: string[],
  host = "127.0.0.1",
  runner: Dev_server_runner = "vite-plus",
) {
  return [
    get_dev_server_command(runner),
    "dev",
    "--host",
    host,
    "--clearScreen",
    "false",
    ...extra_args,
  ];
}

export function build_portless_command(
  route_name: string,
  command_parts: string[],
  exact_hostname = false,
) {
  if (exact_hostname) {
    return [
      "portless",
      "run",
      "--force",
      PORTLESS_EXACT_HOSTNAME_FLAG,
      route_name,
      "--",
      ...command_parts,
    ];
  }

  return ["portless", "run", "--force", "--name", route_name, "--", ...command_parts];
}

export function build_varlock_command(command_parts: string[]) {
  return ["varlock", "run", "--", ...command_parts];
}

export function build_development_command(options: {
  app_name: string;
  public_hostname?: string;
  portless_exact_hostname?: boolean;
  extra_args: string[];
  portless_enabled: boolean;
  runner?: Dev_server_runner;
  vite_host?: string;
  use_varlock: boolean;
}) {
  let command_parts = build_vite_dev_command(
    strip_passthrough_delimiter(options.extra_args),
    options.vite_host,
    options.runner,
  );

  if (options.portless_enabled) {
    const route_name = options.portless_exact_hostname
      ? options.public_hostname
      : options.app_name;

    if (!route_name) {
      throw new Error("A public hostname is required for exact Portless route registration.");
    }

    command_parts = build_portless_command(
      route_name,
      command_parts,
      options.portless_exact_hostname,
    );
  }

  if (options.use_varlock) {
    command_parts = build_varlock_command(command_parts);
  }

  return command_parts;
}
