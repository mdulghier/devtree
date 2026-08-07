import { describe, expect, test } from "vite-plus/test";

import {
  create_hosts_entry,
  format_local_hosts_section,
  format_tailscale_hosts_section,
  is_localhost_hostname,
  parse_tailscale_ipv4,
  resolve_tailscale_ipv4,
} from "./hosts.ts";

describe("hosts entries", () => {
  test("recognizes local-only hostnames", () => {
    expect(is_localhost_hostname("web-ui.localhost")).toBe(true);
    expect(is_localhost_hostname("web-ui.alice.devtree.test")).toBe(false);
  });

  test("formats exact local and Tailscale entries for the current hostname", () => {
    const public_hostname = "feature-123--web-ui.alice.dev.example.com";

    expect(format_local_hosts_section(public_hostname)).toBe(
      [
        "Add to the hosts file on this development machine:",
        "127.0.0.1 feature-123--web-ui.alice.dev.example.com",
      ].join("\n"),
    );
    expect(format_tailscale_hosts_section(public_hostname, "100.101.102.103")).toBe(
      [
        "Add to the hosts file on other Tailscale machines:",
        "100.101.102.103 feature-123--web-ui.alice.dev.example.com",
      ].join("\n"),
    );
  });

  test("uses one space between the address and hostname", () => {
    expect(create_hosts_entry("127.0.0.1", "web-ui.alice.dev.example.com")).toBe(
      "127.0.0.1 web-ui.alice.dev.example.com",
    );
  });
});

describe("Tailscale IPv4 resolution", () => {
  test("reads an IPv4 address from tailscale output", () => {
    expect(parse_tailscale_ipv4("100.101.102.103\n")).toBe("100.101.102.103");
  });

  test("rejects missing and IPv6-only output", () => {
    expect(() => parse_tailscale_ipv4("fd7a:115c:a1e0::1\n")).toThrow(
      "did not return an IPv4 address",
    );
  });

  test("runs the exact Tailscale command", () => {
    const commands: string[][] = [];
    const ip_address = resolve_tailscale_ipv4({
      command_exists: () => true,
      run_command_capture: (command, args) => {
        commands.push([command, ...args]);
        return { status: 0, stdout: "100.64.0.8", stderr: "" };
      },
    });

    expect(commands).toEqual([["tailscale", "ip", "-4"]]);
    expect(ip_address).toBe("100.64.0.8");
  });

  test("explains how to recover when the Tailscale command is unavailable", () => {
    expect(() =>
      resolve_tailscale_ipv4({
        command_exists: () => false,
        run_command_capture: () => ({ status: 1, stdout: "", stderr: "" }),
      }),
    ).toThrow("Install Tailscale, sign in, and try again");
  });

  test("includes the Tailscale error when an address cannot be read", () => {
    expect(() =>
      resolve_tailscale_ipv4({
        command_exists: () => true,
        run_command_capture: () => ({
          status: 1,
          stdout: "",
          stderr: "Logged out.",
        }),
      }),
    ).toThrow("Logged out");
  });
});
