import { describe, expect, test } from "vite-plus/test";

import { build_development_command } from "./command-builder.ts";

describe("build_development_command", () => {
  test("wraps vite with portless by default", () => {
    expect(
      build_development_command({
        app_name: "target-ascent",
        extra_args: ["--", "--open"],
        portless_enabled: true,
        use_varlock: false,
      }),
    ).toEqual([
      "portless",
      "run",
      "--force",
      "--name",
      "target-ascent",
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
      app_name: "target-ascent",
      extra_args: [],
      portless_enabled: true,
      use_varlock: true,
    });

    expect(command_parts[0]).toBe("varlock");
  });
});
