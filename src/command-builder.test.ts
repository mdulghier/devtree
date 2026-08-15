import { describe, expect, test } from "vite-plus/test";

import { build_development_command } from "./command-builder.ts";

describe("build_development_command", () => {
  test("builds the VitePlus development command", () => {
    expect(
      build_development_command({
        extra_args: ["--", "--open"],
        use_varlock: false,
      }),
    ).toEqual(["vp", "dev", "--host", "127.0.0.1", "--clearScreen", "false", "--open"]);
  });

  test("wraps the full command with Varlock when enabled", () => {
    const command_parts = build_development_command({
      extra_args: [],
      use_varlock: true,
    });

    expect(command_parts[0]).toBe("varlock");
  });

  test("listens on a custom Vite host when routing allows it", () => {
    expect(
      build_development_command({
        extra_args: [],
        vite_host: "0.0.0.0",
        use_varlock: false,
      }),
    ).toEqual(["vp", "dev", "--host", "0.0.0.0", "--clearScreen", "false"]);
  });

  test("runs Vite on a fixed loopback port for Caddy", () => {
    expect(
      build_development_command({
        extra_args: [],
        routing_provider: "caddy",
        vite_port: 5178,
        use_varlock: false,
      }),
    ).toEqual([
      "vp",
      "dev",
      "--host",
      "127.0.0.1",
      "--clearScreen",
      "false",
      "--port",
      "5178",
      "--strictPort",
    ]);
  });

  test("rejects direct Vite exposure when Caddy routing is enabled", () => {
    expect(() =>
      build_development_command({
        extra_args: [],
        routing_provider: "caddy",
        vite_host: "0.0.0.0",
        vite_port: 5178,
        use_varlock: false,
      }),
    ).toThrow("requires Vite to stay on 127.0.0.1");
  });

  test("uses Vite when that runner is selected", () => {
    expect(
      build_development_command({
        extra_args: [],
        runner: "vite",
        use_varlock: false,
      }),
    ).toEqual(["vite", "dev", "--host", "127.0.0.1", "--clearScreen", "false"]);
  });
});
