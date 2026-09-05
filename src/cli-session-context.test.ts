import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import { create_environment_session, stop_environment_session } from "./environment-registry.ts";
import { create_devtree_instance } from "./instance.ts";

const cli_path = resolve(import.meta.dirname, "cli.ts");
const tsx_loader_path = createRequire(import.meta.url).resolve("tsx");
const print_context = `console.log(JSON.stringify({session: process.env.DEVTREE_SESSION_NAME, owner: process.env.DEVTREE_DEPENDENCY_OWNER, database: process.env.DATABASE_URL}))`;

function fixture() {
  const repo_root = realpathSync(mkdtempSync(resolve(tmpdir(), "devtree-context-")));
  const home_path = resolve(repo_root, "home");
  const state_root = resolve(home_path, ".devtree");
  const env_path = resolve(repo_root, ".env.local");
  const config_path = resolve(repo_root, "devtree.config.ts");
  writeFileSync(
    config_path,
    `export default {
    project_name: "context-test",
    portless: { enabled: false },
    env: { provider: "dotenv", entries: ({ dependencies }) => [
      { kind: "value", key: "DATABASE_URL", value: "postgres://" + dependencies.owner_name }
    ] },
    dependencies: [{ kind: "command", name: "database",
      start: { command: ${JSON.stringify([process.execPath, "-e", print_context])} },
      logs: { command: ${JSON.stringify([process.execPath, "-e", print_context])} }
    }]
  };`,
  );
  const loaded_config: Loaded_devtree_config = {
    repo_root,
    config_path,
    config: { project_name: "context-test", env: { provider: "dotenv", entries: () => [] } },
  };
  return {
    env_path,
    activate(session_name: string, dependency_owner = session_name) {
      const instance = create_devtree_instance(loaded_config, { session_name, dependency_owner });
      return create_environment_session(instance, state_root);
    },
    deactivate(session_id: string) {
      stop_environment_session(session_id, state_root);
    },
    run(args: string[]) {
      return spawnSync(process.execPath, ["--import", tsx_loader_path, cli_path, ...args], {
        cwd: repo_root,
        encoding: "utf8",
        env: { ...process.env, HOME: home_path },
      });
    },
    cleanup() {
      rmSync(repo_root, { recursive: true, force: true });
    },
  };
}

describe("session context across CLI commands", { timeout: 15_000 }, () => {
  test("inspection follows the live isolated session without creating or rewriting env files", () => {
    const project = fixture();
    try {
      project.activate("billing");
      const info = project.run(["info"]);
      expect(info.status).toBe(0);
      expect(info.stdout).toContain("Session: billing");
      expect(info.stdout).toContain("Dependencies: self");
      expect(existsSync(project.env_path)).toBe(false);

      writeFileSync(project.env_path, "CUSTOM=preserve-me\n");
      const alternate = project.run(["info", "--name", "other", "--deps", "shared"]);
      expect(alternate.status).toBe(1);
      expect(alternate.stderr).toContain("Stop it before changing the selection");
      expect(readFileSync(project.env_path, "utf8")).toBe("CUSTOM=preserve-me\n");
      const show = project.run(["env", "show"]);
      expect(show.stdout).toContain("Session: billing");
    } finally {
      project.cleanup();
    }
  });

  test("exec inherits the live dependency selection, rejects changes while live, and forwards exit status", () => {
    const project = fixture();
    try {
      project.activate("billing", "reporting");
      const execute = (options: string[]) =>
        project.run(["exec", ...options, "--", process.execPath, "-e", print_context]);
      const active = execute([]);
      expect(active.status).toBe(0);
      expect(JSON.parse(active.stdout)).toEqual({
        session: "billing",
        owner: "reporting",
        database: "postgres://reporting",
      });
      expect(JSON.parse(execute(["--name", "billing"]).stdout).owner).toBe("reporting");
      expect(execute(["-d"]).status).toBe(1);
      expect(execute(["--name", "other", "-d"]).status).toBe(1);
      expect(existsSync(project.env_path)).toBe(false);
      expect(project.run(["exec", "--", process.execPath, "-e", "process.exit(7)"]).status).toBe(7);
    } finally {
      project.cleanup();
    }
  });

  test("dependency commands and setup accept session options and retain the selected session after exit", () => {
    const project = fixture();
    try {
      const session = project.activate("billing");
      const logs = project.run(["deps", "logs"]);
      expect(logs.status).toBe(0);
      expect(JSON.parse(logs.stdout).owner).toBe("billing");
      const start = project.run(["deps", "start", "--name", "other", "-d"]);
      expect(start.status).toBe(1);
      project.deactivate(session.session_id);
      const setup = project.run(["setup", "--name", "other", "-d"]);
      expect(setup.status).toBe(0);
      expect(setup.stdout).toContain('"owner":"other"');
      expect(readFileSync(project.env_path, "utf8")).toContain("DATABASE_URL=postgres://other");
      expect(project.run(["info"]).stdout).toContain("Session: other");
    } finally {
      project.cleanup();
    }
  });

  test("rejected starts and conflicting env writes preserve the running checkout environment", () => {
    const project = fixture();
    try {
      project.activate("billing");
      const original_env = "DATABASE_URL=postgres://billing\n";
      writeFileSync(project.env_path, original_env);
      expect(project.run(["dev", "--name", "other", "-d"]).status).toBe(1);
      expect(readFileSync(project.env_path, "utf8")).toBe(original_env);
      const write = project.run(["env", "write", "--deps", "other"]);
      expect(write.status).toBe(1);
      expect(write.stderr).toContain("Stop it before changing the selection");
      expect(readFileSync(project.env_path, "utf8")).toBe(original_env);
      expect(project.run(["env", "write"]).status).toBe(0);
      expect(readFileSync(project.env_path, "utf8")).toContain("DATABASE_URL=postgres://billing");
    } finally {
      project.cleanup();
    }
  });
});
