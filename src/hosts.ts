import { isIP } from "node:net";

import { command_exists, run_command_capture, type Command_result } from "./process.ts";

type Hosts_command_dependencies = {
  command_exists: (command: string) => boolean;
  run_command_capture: (command: string, args: string[]) => Command_result;
};

const default_dependencies: Hosts_command_dependencies = {
  command_exists,
  run_command_capture: (command, args) =>
    run_command_capture(command, args, { allow_failure: true }),
};

export function create_hosts_entry(ip_address: string, public_hostname: string) {
  return `${ip_address} ${public_hostname}`;
}

export function is_localhost_hostname(public_hostname: string) {
  return public_hostname === "localhost" || public_hostname.endsWith(".localhost");
}

function normalize_hostnames(public_hostnames: string | string[]) {
  return Array.isArray(public_hostnames) ? public_hostnames : [public_hostnames];
}

export function format_local_hosts_section(public_hostnames: string | string[]) {
  return [
    "Add to the hosts file on this development machine:",
    ...normalize_hostnames(public_hostnames).map((hostname) =>
      create_hosts_entry("127.0.0.1", hostname),
    ),
  ].join("\n");
}

export function format_tailscale_hosts_section(
  public_hostnames: string | string[],
  tailscale_ip: string,
) {
  return [
    "Add to the hosts file on other Tailscale machines:",
    ...normalize_hostnames(public_hostnames).map((hostname) =>
      create_hosts_entry(tailscale_ip, hostname),
    ),
  ].join("\n");
}

export function parse_tailscale_ipv4(stdout: string) {
  const ip_address = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isIP(line) === 4);

  if (!ip_address) {
    throw new Error("`tailscale ip -4` did not return an IPv4 address");
  }

  return ip_address;
}

export function resolve_tailscale_ipv4(
  dependencies: Hosts_command_dependencies = default_dependencies,
) {
  if (!dependencies.command_exists("tailscale")) {
    throw new Error(
      "Cannot print the entry for other machines because the `tailscale` command is not available. Install Tailscale, sign in, and try again.",
    );
  }

  const ip_result = dependencies.run_command_capture("tailscale", ["ip", "-4"]);

  if (ip_result.status !== 0) {
    const detail = ip_result.stderr || ip_result.stdout;
    const detail_suffix = detail ? ` (${detail})` : "";

    throw new Error(
      `Cannot print the entry for other machines because Tailscale did not return this machine's IPv4 address${detail_suffix}. Make sure Tailscale is connected, then try again.`,
    );
  }

  try {
    return parse_tailscale_ipv4(ip_result.stdout);
  } catch {
    throw new Error(
      "Cannot print the entry for other machines because `tailscale ip -4` did not return an IPv4 address. Make sure Tailscale is connected, then try again.",
    );
  }
}
