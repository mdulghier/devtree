export function strip_passthrough_delimiter(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args;
}

export function build_vite_dev_command(extra_args: string[], host = "127.0.0.1") {
  return ["vp", "dev", "--host", host, "--clearScreen", "false", ...extra_args];
}

export function build_portless_command(app_name: string, command_parts: string[]) {
  return ["portless", "run", "--force", "--name", app_name, "--", ...command_parts];
}

export function build_varlock_command(command_parts: string[]) {
  return ["varlock", "run", "--", ...command_parts];
}

export function build_development_command(options: {
  app_name: string;
  extra_args: string[];
  portless_enabled: boolean;
  vite_host?: string;
  use_varlock: boolean;
}) {
  let command_parts = build_vite_dev_command(
    strip_passthrough_delimiter(options.extra_args),
    options.vite_host,
  );

  if (options.portless_enabled) {
    command_parts = build_portless_command(options.app_name, command_parts);
  }

  if (options.use_varlock) {
    command_parts = build_varlock_command(command_parts);
  }

  return command_parts;
}
