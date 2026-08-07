import { describe, expect, test } from "vite-plus/test";

import { build_development_command, build_portless_command } from "./command-builder.ts";

describe("build_development_command", () => {
  test("wraps vite-plus with portless by default", () => {
    expect(
      build_development_command({
        app_name: "demo-app",
        extra_args: ["--", "--open"],
        portless_enabled: true,
        use_varlock: false,
      }),
    ).toEqual([
      "portless",
      "run",
      "--force",
      "--name",
      "demo-app",
      "--",
      "vp",
      "dev",
      "--host",
      "127.0.0.1",
      "--clearScreen",
      "false",
      "--open",
    ]);
  });

  test("wraps the full command with varlock when enabled", () => {
    const command_parts = build_development_command({
      app_name: "demo-app",
      extra_args: [],
      portless_enabled: true,
      use_varlock: true,
    });

    expect(command_parts[0]).toBe("varlock");
  });

  test("registers the exact canonical Portless hostname", () => {
    expect(
      build_portless_command(
        "feature-123--web-ui.developer.dev.example.com",
        ["vite", "dev"],
        true,
      ),
    ).toEqual([
      "portless",
      "run",
      "--force",
      "--hostname",
      "feature-123--web-ui.developer.dev.example.com",
      "--",
      "vite",
      "dev",
    ]);
  });

  test("does not add a second worktree prefix to an exact route", () => {
    const command = build_development_command({
      app_name: "web-ui",
      public_hostname: "feature-123--web-ui.developer.dev.example.com",
      portless_exact_hostname: true,
      extra_args: [],
      portless_enabled: true,
      use_varlock: false,
    });

    expect(command.filter((part) => part.includes("feature-123"))).toEqual([
      "feature-123--web-ui.developer.dev.example.com",
    ]);
    expect(command).not.toContain("--name");
  });

  test("listens on all interfaces when a custom vite host is provided", () => {
    expect(
      build_development_command({
        app_name: "demo-app",
        extra_args: [],
        portless_enabled: false,
        vite_host: "0.0.0.0",
        use_varlock: false,
      }),
    ).toEqual(["vp", "dev", "--host", "0.0.0.0", "--clearScreen", "false"]);
  });

  test("keeps Vite on loopback in Portless proxy mode", () => {
    expect(
      build_development_command({
        app_name: "web-ui",
        public_hostname: "feature-123--web-ui.developer.dev.example.com",
        portless_exact_hostname: true,
        extra_args: [],
        portless_enabled: true,
        vite_host: "127.0.0.1",
        use_varlock: false,
      }),
    ).toContain("127.0.0.1");
  });

  test("uses vite when the vite runner is selected", () => {
    expect(
      build_development_command({
        app_name: "demo-app",
        extra_args: [],
        portless_enabled: false,
        runner: "vite",
        use_varlock: false,
      }),
    ).toEqual(["vite", "dev", "--host", "127.0.0.1", "--clearScreen", "false"]);
  });
});
