import { describe, expect, test } from "vite-plus/test";

import {
  format_environment_list,
  format_environment_list_json,
} from "./environment-list.ts";
import type { Environment_session } from "./environment-registry.ts";

function create_session(runner_pid: number | null): Environment_session {
  return {
    version: 1,
    session_id: "session-123",
    instance_id: "instance-123",
    app_name: "web-ui",
    worktree_slug: "feature-123",
    worktree_path: "/tmp/web-ui-feature-123",
    public_url: "http://feature-123.web-ui.localhost:1355",
    routing_provider: "portless",
    controller_pid: 1234,
    runner_pid,
    started_at: "2026-08-10T12:42:18.000Z",
  };
}

describe("environment list formatting", () => {
  test("formats a readable table with both process IDs", () => {
    const output = format_environment_list([create_session(1235)]);

    expect(output).toContain("INSTANCE");
    expect(output).toContain("web-ui/feature-123");
    expect(output).toContain("running");
    expect(output).toContain("1234,1235");
    expect(output).toContain("/tmp/web-ui-feature-123");
  });

  test("includes stable fields and computed status in JSON output", () => {
    const output = JSON.parse(
      format_environment_list_json([create_session(null)]),
    ) as Array<Record<string, unknown>>;

    expect(output).toHaveLength(1);
    expect(output[0]?.session_id).toBe("session-123");
    expect(output[0]?.controller_pid).toBe(1234);
    expect(output[0]?.runner_pid).toBeNull();
    expect(output[0]?.status).toBe("starting");
  });

  test("prints a clear empty state", () => {
    expect(format_environment_list([])).toBe(
      "No running Devtree environments.",
    );
    expect(format_environment_list_json([])).toBe("[]");
  });
});
