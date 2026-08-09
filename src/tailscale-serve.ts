import type { Devtree_instance } from "./instance.ts";
import {
  get_routing_state_path,
  get_tailscale_mapping_key,
  persist_active_tailscale_routing,
  read_routing_state,
  remove_tailscale_mapping_state,
  type Active_tailscale_routing,
} from "./routing-state.ts";
import {
  command_exists,
  run_command_capture,
  type Command_result,
} from "./process.ts";
import type { Resolved_tailscale } from "./tailscale.ts";

type Tailscale_tcp_handler = {
  TCPForward?: string;
  TerminateTLS?: string;
  HTTP?: boolean;
  HTTPS?: boolean;
  ProxyProtocol?: number;
};

type Tailscale_serve_config = {
  TCP?: Record<string, Tailscale_tcp_handler | null>;
  Foreground?: Record<string, Tailscale_serve_config | null>;
};

export type Tailscale_serve_port_status =
  | {
      kind: "missing";
    }
  | {
      kind: "tcp";
      target: string;
      terminate_tls: boolean;
      proxy_protocol: number;
      foreground: boolean;
    }
  | {
      kind: "web";
      protocol: "http" | "https";
      foreground: boolean;
    }
  | {
      kind: "ambiguous";
    };

export type Tailscale_serve_dependencies = {
  command_exists: (command: string) => boolean;
  run_command_capture: (command: string, args: string[]) => Command_result;
};

const default_dependencies: Tailscale_serve_dependencies = {
  command_exists,
  run_command_capture: (command, args) =>
    run_command_capture(command, args, { allow_failure: true }),
};

function validate_port(port: number, source: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be an integer from 1 to 65535.`);
  }
}

export function resolve_tailscale_serve_port(
  configured_port: number | undefined,
  routing_port: number,
) {
  const serve_port = configured_port ?? routing_port;

  validate_port(serve_port, "tailscale.serve_port");
  return serve_port;
}

export function create_tailscale_target(local_port: number) {
  validate_port(local_port, "Tailscale target port");
  return `localhost:${local_port}`;
}

export function create_tailscale_url(
  hostname: string,
  https: boolean,
  serve_port: number,
) {
  validate_port(serve_port, "Tailscale Serve port");
  return `${https ? "https" : "http"}://${hostname}:${serve_port}`;
}

function get_handler_status(
  handler: Tailscale_tcp_handler,
  foreground: boolean,
): Exclude<Tailscale_serve_port_status, { kind: "missing" | "ambiguous" }> {
  if (handler.TCPForward) {
    return {
      kind: "tcp",
      target: handler.TCPForward,
      terminate_tls: Boolean(handler.TerminateTLS),
      proxy_protocol: handler.ProxyProtocol ?? 0,
      foreground,
    };
  }

  return {
    kind: "web",
    protocol: handler.HTTP ? "http" : "https",
    foreground,
  };
}

export function parse_tailscale_serve_port_status(
  status_json: string,
  serve_port: number,
): Tailscale_serve_port_status {
  validate_port(serve_port, "Tailscale Serve port");

  const parsed_status = JSON.parse(status_json) as Tailscale_serve_config | null;
  const statuses: Array<Exclude<Tailscale_serve_port_status, { kind: "missing" }>> = [];
  const background_handler = parsed_status?.TCP?.[String(serve_port)];

  if (background_handler) {
    statuses.push(get_handler_status(background_handler, false));
  }

  for (const foreground_config of Object.values(parsed_status?.Foreground ?? {})) {
    const foreground_handler = foreground_config?.TCP?.[String(serve_port)];

    if (foreground_handler) {
      statuses.push(get_handler_status(foreground_handler, true));
    }
  }

  if (statuses.length === 0) {
    return { kind: "missing" };
  }

  if (statuses.length > 1) {
    return { kind: "ambiguous" };
  }

  return statuses[0];
}

export function tailscale_serve_mapping_matches(
  status: Tailscale_serve_port_status,
  target: string,
) {
  return (
    status.kind === "tcp" &&
    targets_are_equivalent(status.target, target) &&
    !status.terminate_tls &&
    status.proxy_protocol === 0 &&
    !status.foreground
  );
}

function targets_are_equivalent(left_target: string, right_target: string) {
  if (left_target === right_target) {
    return true;
  }

  try {
    const left_url = new URL(`tcp://${left_target}`);
    const right_url = new URL(`tcp://${right_target}`);
    const loopback_hosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

    return (
      left_url.port === right_url.port &&
      loopback_hosts.has(left_url.hostname) &&
      loopback_hosts.has(right_url.hostname)
    );
  } catch {
    return false;
  }
}

export function describe_tailscale_serve_status(status: Tailscale_serve_port_status) {
  if (status.kind === "missing") {
    return "no mapping";
  }

  if (status.kind === "ambiguous") {
    return "multiple foreground or background mappings";
  }

  if (status.kind === "web") {
    return `${status.foreground ? "foreground " : ""}${status.protocol.toUpperCase()} Serve route`;
  }

  const annotations = [
    status.terminate_tls ? "TLS-terminated" : "raw TCP",
    status.proxy_protocol ? `PROXY protocol v${status.proxy_protocol}` : null,
    status.foreground ? "foreground" : null,
  ].filter((annotation): annotation is string => Boolean(annotation));

  return `tcp://${status.target} (${annotations.join(", ")})`;
}

function run_serve_status(dependencies: Tailscale_serve_dependencies) {
  const status_result = dependencies.run_command_capture("tailscale", [
    "serve",
    "status",
    "--json",
  ]);

  if (status_result.status !== 0) {
    const detail = status_result.stderr || status_result.stdout;
    const detail_suffix = detail ? ` ${detail}` : "";
    throw new Error(
      `Could not inspect Tailscale Serve configuration.${detail_suffix}`,
    );
  }

  return status_result.stdout || "{}";
}

function require_connected_tailscale(tailscale: Resolved_tailscale) {
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

function create_active_routing(options: {
  instance: Devtree_instance;
  tailscale: Resolved_tailscale;
  serve_port: number;
  mapping_owned: boolean;
  target: string;
}) {
  const { instance, tailscale } = options;

  require_connected_tailscale(tailscale);

  const node_id = tailscale.node_id as string;
  const tailscale_ipv4 = tailscale.ipv4 as string;

  return {
    local_url: instance.public_url,
    local_hostname: instance.public_hostname,
    tailscale_url: create_tailscale_url(
      instance.public_hostname,
      instance.public_url.startsWith("https://"),
      options.serve_port,
    ),
    tailscale_hostname: instance.public_hostname,
    tailscale_port: options.serve_port,
    tailscale_ipv4,
    mapping_key: get_tailscale_mapping_key(node_id, options.serve_port),
    mapping_target: options.target,
    mapping_owned: options.mapping_owned,
  } satisfies Active_tailscale_routing;
}

export function inspect_tailscale_serve(options: {
  instance: Devtree_instance;
  tailscale: Resolved_tailscale;
  routing_port: number;
  serve_port: number;
  state_path?: string;
  dependencies?: Tailscale_serve_dependencies;
}) {
  const dependencies = options.dependencies ?? default_dependencies;

  require_connected_tailscale(options.tailscale);

  if (!dependencies.command_exists("tailscale")) {
    throw new Error(
      "Tailscale proxy mode requires the `tailscale` command. Install Tailscale, sign in, and try again.",
    );
  }

  const target = create_tailscale_target(options.routing_port);
  const status = parse_tailscale_serve_port_status(
    run_serve_status(dependencies),
    options.serve_port,
  );
  const node_id = options.tailscale.node_id as string;
  const mapping_key = get_tailscale_mapping_key(node_id, options.serve_port);
  const state_path = options.state_path ?? get_routing_state_path();
  const persisted_mapping =
    read_routing_state(state_path).tailscale_mappings[mapping_key] ?? null;

  return {
    status,
    target,
    mapping_key,
    persisted_mapping,
    matches: tailscale_serve_mapping_matches(status, target),
  };
}

export function ensure_tailscale_serve(options: {
  instance: Devtree_instance;
  tailscale: Resolved_tailscale;
  routing_port: number;
  serve_port: number;
  state_path?: string;
  dependencies?: Tailscale_serve_dependencies;
}) {
  const dependencies = options.dependencies ?? default_dependencies;
  const state_path = options.state_path ?? get_routing_state_path();
  const inspection = inspect_tailscale_serve({
    ...options,
    state_path,
    dependencies,
  });
  let mapping_owned =
    inspection.persisted_mapping?.owned === true &&
    inspection.persisted_mapping.target === inspection.target;

  if (inspection.status.kind === "missing") {
    const setup_result = dependencies.run_command_capture("tailscale", [
      "serve",
      `--tcp=${options.serve_port}`,
      "--bg",
      "--yes",
      `tcp://${inspection.target}`,
    ]);

    if (setup_result.status !== 0) {
      const detail = setup_result.stderr || setup_result.stdout;
      const detail_suffix = detail ? ` ${detail}` : "";
      throw new Error(
        `Could not configure Tailscale Serve TCP port ${options.serve_port} -> ${inspection.target}.${detail_suffix}`,
      );
    }

    const confirmed_status = parse_tailscale_serve_port_status(
      run_serve_status(dependencies),
      options.serve_port,
    );

    if (!tailscale_serve_mapping_matches(confirmed_status, inspection.target)) {
      throw new Error(
        `Tailscale did not retain the requested Serve mapping on port ${options.serve_port}. ` +
        `Expected tcp://${inspection.target}, found ${describe_tailscale_serve_status(confirmed_status)}.`,
      );
    }

    mapping_owned = true;
  } else if (!inspection.matches) {
    throw new Error(
      `Tailscale Serve port ${options.serve_port} conflicts with Devtree. ` +
        `Devtree needs raw TCP forwarding to tcp://${inspection.target}, but found ${describe_tailscale_serve_status(inspection.status)}. ` +
        "Choose another tailscale.serve_port or remove the conflicting route explicitly. Devtree did not change it.",
    );
  }

  const active_routing = create_active_routing({
    instance: options.instance,
    tailscale: options.tailscale,
    serve_port: options.serve_port,
    mapping_owned,
    target: inspection.target,
  });

  persist_active_tailscale_routing({
    active_routing,
    instance: options.instance,
    node_id: options.tailscale.node_id as string,
    state_path,
  });

  return active_routing;
}

export function remove_owned_tailscale_serve(options: {
  instance: Devtree_instance;
  tailscale: Resolved_tailscale;
  routing_port: number;
  serve_port: number;
  state_path?: string;
  dependencies?: Tailscale_serve_dependencies;
}) {
  const dependencies = options.dependencies ?? default_dependencies;
  const state_path = options.state_path ?? get_routing_state_path();
  const inspection = inspect_tailscale_serve({
    ...options,
    state_path,
    dependencies,
  });

  if (inspection.status.kind === "missing") {
    remove_tailscale_mapping_state(inspection.mapping_key, state_path);
    return { removed: false, already_missing: true };
  }

  if (
    !inspection.persisted_mapping?.owned ||
    inspection.persisted_mapping.target !== inspection.target ||
    !inspection.matches
  ) {
    throw new Error(
      `Refusing to remove Tailscale Serve port ${options.serve_port}: Devtree cannot prove ownership of the live ${describe_tailscale_serve_status(inspection.status)} mapping. No routes were changed.`,
    );
  }

  const remove_result = dependencies.run_command_capture("tailscale", [
    "serve",
    `--tcp=${options.serve_port}`,
    "--yes",
    "off",
  ]);

  if (remove_result.status !== 0) {
    const detail = remove_result.stderr || remove_result.stdout;
    const detail_suffix = detail ? ` ${detail}` : "";
    throw new Error(
      `Could not remove Devtree's Tailscale Serve mapping on port ${options.serve_port}.${detail_suffix}`,
    );
  }

  const confirmed_status = parse_tailscale_serve_port_status(
    run_serve_status(dependencies),
    options.serve_port,
  );

  if (confirmed_status.kind !== "missing") {
    throw new Error(
      `Tailscale Serve port ${options.serve_port} is still configured as ${describe_tailscale_serve_status(confirmed_status)} after removal.`,
    );
  }

  remove_tailscale_mapping_state(inspection.mapping_key, state_path);

  return { removed: true, already_missing: false };
}
