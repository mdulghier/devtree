import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  create_caddy_config,
  get_caddy_listen_addresses,
  is_caddy_ready,
  normalize_caddy_admin_url,
} from "./caddy.ts";
import {
  command_exists,
  run_command_logged,
  type Command_result,
  type Logged_command_options,
} from "./process.ts";

type Caddy_process_dependencies = {
  command_exists: (command: string) => boolean;
  get_caddy_listen_addresses: (admin_url: string) => Promise<string[] | null>;
  is_caddy_ready: (admin_url: string) => Promise<boolean>;
  run_command_logged: (
    command: string,
    args: string[],
    log_path: string,
    options?: Logged_command_options,
  ) => Promise<Command_result>;
};

const default_dependencies: Caddy_process_dependencies = {
  command_exists,
  get_caddy_listen_addresses,
  is_caddy_ready,
  run_command_logged,
};

export function get_caddy_state_paths(state_root = resolve(homedir(), ".devtree", "caddy")) {
  return {
    state_root,
    config_path: resolve(state_root, "caddy.json"),
    log_path: resolve(state_root, "caddy.log"),
    pid_path: resolve(state_root, "caddy.pid"),
    xdg_config_home: resolve(state_root, "config"),
    xdg_data_home: resolve(state_root, "data"),
  };
}

function write_caddy_config(public_port: number, admin_url: string, state_root?: string) {
  const paths = get_caddy_state_paths(state_root);

  mkdirSync(paths.state_root, { recursive: true });
  mkdirSync(paths.xdg_config_home, { recursive: true });
  mkdirSync(paths.xdg_data_home, { recursive: true });
  writeFileSync(
    paths.config_path,
    `${JSON.stringify(create_caddy_config(public_port, admin_url), null, 2)}\n`,
  );

  return paths;
}

async function ensure_caddy_public_port(
  admin_url: string,
  public_port: number,
  dependencies: Caddy_process_dependencies,
) {
  const listen_addresses = await dependencies.get_caddy_listen_addresses(admin_url);
  const expected_address = `127.0.0.1:${public_port}`;

  if (listen_addresses?.includes(expected_address)) {
    return;
  }

  const current_addresses = listen_addresses?.join(", ") || "no listener";

  throw new Error(
    `Devtree's Caddy process listens on ${current_addresses}, not ${expected_address}. ` +
      "All projects using the shared Caddy process must use the same routing.port. " +
      `Change routing.port or stop Caddy with \`caddy stop --address ${new URL(admin_url).host}\`, then run \`pnpm devtree doctor --fix\` again.`,
  );
}

export async function ensure_caddy_process(options: {
  admin_url: string;
  public_port: number;
  should_start: boolean;
  state_root?: string;
  dependencies?: Caddy_process_dependencies;
}) {
  const dependencies = options.dependencies ?? default_dependencies;
  const admin_url = normalize_caddy_admin_url(options.admin_url);
  let admin_reachable = false;
  let caddy_ready = false;

  try {
    caddy_ready = await dependencies.is_caddy_ready(admin_url);
    admin_reachable = true;
  } catch {
    // A failed request means there is no usable Caddy process at this address yet.
  }

  if (caddy_ready) {
    await ensure_caddy_public_port(admin_url, options.public_port, dependencies);
    return;
  }

  if (admin_reachable) {
    throw new Error(
      `Caddy is reachable at ${admin_url}, but it does not contain Devtree's server. ` +
        "Choose another routing.provider.admin_url or stop the conflicting Caddy process.",
    );
  }

  if (!options.should_start) {
    throw new Error(
      `Devtree's Caddy process is not reachable at ${admin_url}. ` +
        "Start it manually or run `pnpm devtree doctor --fix` to start it.",
    );
  }

  if (!dependencies.command_exists("caddy")) {
    throw new Error(
      "Caddy routing is enabled, but the `caddy` command is not available. Install Caddy and run `pnpm devtree doctor --fix`.",
    );
  }

  const paths = write_caddy_config(options.public_port, admin_url, options.state_root);
  const start_result = await dependencies.run_command_logged(
    "caddy",
    ["start", "--config", paths.config_path, "--pidfile", paths.pid_path],
    paths.log_path,
    {
      allow_failure: true,
      cwd: paths.state_root,
      detached: true,
      env: {
        XDG_CONFIG_HOME: paths.xdg_config_home,
        XDG_DATA_HOME: paths.xdg_data_home,
      },
    },
  );

  let started_ready = false;

  try {
    started_ready = await dependencies.is_caddy_ready(admin_url);
  } catch {
    // Report the command failure below with Caddy's own output when available.
  }

  if (started_ready) {
    await ensure_caddy_public_port(admin_url, options.public_port, dependencies);
    return;
  }

  const detail = start_result.stderr || start_result.stdout;

  if (detail.includes("address already in use")) {
    throw new Error(
      `Caddy cannot listen on 127.0.0.1:${options.public_port} because the port is already in use. ` +
        `If Portless is using it, run \`portless proxy stop -p ${options.public_port}\`. ` +
        "Otherwise stop the process using the port or choose another routing.port, then run `pnpm devtree doctor --fix` again.",
    );
  }

  const detail_suffix = detail ? ` ${detail}` : "";

  throw new Error(
    `Could not start Devtree's Caddy process at ${admin_url}.${detail_suffix}`,
  );
}
