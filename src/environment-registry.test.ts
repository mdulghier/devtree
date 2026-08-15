import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import {
  assert_environment_session_available,
  create_environment_session,
  get_environment_sessions_path,
  list_dependency_stack_sessions,
  list_environment_sessions,
  remove_environment_session,
  set_environment_session_runner_pid,
  type Environment_session,
} from "./environment-registry.ts";
import { create_devtree_instance } from "./instance.ts";

function create_instance(repo_root: string) {
  const loaded_config: Loaded_devtree_config = {
    config: {
      project_name: "web-ui",
      env: {
        provider: "dotenv",
        entries: () => [],
      },
    },
    config_path: resolve(repo_root, "devtree.config.ts"),
    repo_root,
  };

  return create_devtree_instance(loaded_config);
}

function wait_for_exit(command: string, args: string[]) {
  const child_process = spawn(command, args, { stdio: "ignore" });
  const child_pid = child_process.pid;

  if (child_pid === undefined) {
    throw new Error("Expected the test process to have a PID.");
  }

  return new Promise<number>((resolve_result, reject_result) => {
    child_process.once("error", reject_result);
    child_process.once("exit", () => resolve_result(child_pid));
  });
}

describe("environment registry", () => {
  test("rejects a second live session with the same project and name", () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-registry-name-test-"));

    try {
      const instance = create_instance("/tmp/devtree-registry-name-worktree");
      const session = create_environment_session(instance, state_root);

      expect(() => assert_environment_session_available(instance, state_root)).toThrow(
        'Session "web-ui/default" is already starting',
      );

      remove_environment_session(session.session_id, state_root);
      expect(() => assert_environment_session_available(instance, state_root)).not.toThrow();
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });

  test("rejects a second session from the same worktree", () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-registry-path-test-"));

    try {
      const first_instance = create_instance("/tmp/devtree-registry-shared-worktree");
      const session = create_environment_session(first_instance, state_root);
      const second_instance = {
        ...first_instance,
        session_name: "another-session",
      };

      expect(() => assert_environment_session_available(second_instance, state_root)).toThrow(
        "already runs session",
      );

      remove_environment_session(session.session_id, state_root);
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });

  test("finds every live session using a dependency owner", () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-registry-deps-test-"));

    try {
      const instance = create_instance("/tmp/devtree-registry-deps-worktree");
      const session = create_environment_session(instance, state_root);

      expect(list_dependency_stack_sessions("web-ui", "default", state_root)).toEqual([session]);
      expect(list_dependency_stack_sessions("web-ui", "other", state_root)).toEqual([]);

      remove_environment_session(session.session_id, state_root);
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });

  test("creates, updates, lists, and removes a live session", () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-registry-test-"));

    try {
      const session = create_environment_session(
        create_instance("/tmp/devtree-registry-worktree"),
        state_root,
      );
      const session_path = resolve(
        get_environment_sessions_path(state_root),
        `${session.session_id}.json`,
      );

      expect(session.runner_pid).toBeNull();
      expect(list_environment_sessions(state_root)).toEqual([session]);

      set_environment_session_runner_pid(session, 43210, state_root);

      expect(
        (JSON.parse(readFileSync(session_path, "utf8")) as Environment_session).runner_pid,
      ).toBe(43210);
      expect(list_environment_sessions(state_root)[0]?.runner_pid).toBe(43210);

      remove_environment_session(session.session_id, state_root);
      expect(existsSync(session_path)).toBe(false);
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });

  test("prunes sessions whose controller has exited", async () => {
    const state_root = mkdtempSync(resolve(tmpdir(), "devtree-registry-stale-test-"));

    try {
      const dead_pid = await wait_for_exit(process.execPath, ["-e", "process.exit(0)"]);
      const session = create_environment_session(
        create_instance("/tmp/devtree-registry-stale-worktree"),
        state_root,
      );
      const session_path = resolve(
        get_environment_sessions_path(state_root),
        `${session.session_id}.json`,
      );

      writeFileSync(session_path, `${JSON.stringify({ ...session, controller_pid: dead_pid })}\n`);

      expect(list_environment_sessions(state_root)).toEqual([]);
      expect(existsSync(session_path)).toBe(false);
    } finally {
      rmSync(state_root, { force: true, recursive: true });
    }
  });
});
