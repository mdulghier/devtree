import { describe, expect, test } from "vite-plus/test";

import { run_command_inherit_async } from "./process.ts";

describe("async process runner", () => {
  test("reports the spawned process ID", async () => {
    let spawned_pid: number | undefined;

    const exit_status = await run_command_inherit_async(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        on_spawn: (pid) => {
          spawned_pid = pid;
        },
      },
    );

    expect(exit_status).toBe(0);
    expect(spawned_pid).toBeTypeOf("number");
    expect(spawned_pid).toBeGreaterThan(0);
  });
});
