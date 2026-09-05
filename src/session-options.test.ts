import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import {
  parse_session_options,
  resolve_session_instance,
  type Prompt_dependencies,
} from "./session-options.ts";

const state_roots: string[] = [];
function state_root() {
  const root = mkdtempSync(resolve(tmpdir(), "devtree-session-options-"));
  state_roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of state_roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function create_loaded_config(): Loaded_devtree_config {
  return {
    config: {
      project_name: "acme-cloud",
      env: { provider: "dotenv", entries: () => [] },
    },
    config_path: "/repo/devtree.config.ts",
    repo_root: "/repo",
  };
}

function create_prompts(overrides: Partial<Prompt_dependencies> = {}) {
  return {
    ask_name: async () => "feature-one",
    ask_dependency_owner: async () => "default",
    cancel: () => undefined,
    intro: () => undefined,
    is_cancel: () => false,
    note: () => undefined,
    outro: () => undefined,
    ...overrides,
  } satisfies Prompt_dependencies;
}

describe("session options", () => {
  test("parses named sessions, dependency reuse, and Vite passthrough arguments", () => {
    expect(
      parse_session_options(["--name", "feature-one", "--deps=reporting", "--", "--open"]),
    ).toEqual({
      interactive: false,
      session_name: "feature-one",
      dependency_owner: "reporting",
      own_dependencies: false,
      passthrough_args: ["--open"],
    });
  });

  test.each([["--deps"], ["-d"], ["--deps="]])(
    "%s selects an owned dependency stack",
    (argument) => {
      expect(parse_session_options([argument]).own_dependencies).toBe(true);
    },
  );

  test("rejects conflicting dependency choices", () => {
    expect(() => parse_session_options(["-d", "--deps", "default"])).toThrow("Choose either");
  });

  test("interactive mode asks for unresolved values and returns the summary instance", async () => {
    const notes: string[] = [];
    let dependency_options: Array<{ value: string }> = [];
    let dependency_initial_value = "";
    const prompts = create_prompts({
      ask_dependency_owner: async (options, initial_value) => {
        dependency_options = options;
        dependency_initial_value = initial_value;
        return "__self__";
      },
      note: (message) => notes.push(message),
    });

    const instance = await resolve_session_instance(
      create_loaded_config(),
      parse_session_options(["-i"]),
      prompts,
      state_root(),
    );

    expect(instance).toMatchObject({
      project_name: "acme-cloud",
      session_name: "feature-one",
      dependency_owner: "feature-one",
    });
    expect(notes[0]).toContain("Project       acme-cloud");
    expect(notes[0]).toContain("Session       feature-one");
    expect(dependency_initial_value).toBe("__self__");
    expect(dependency_options.filter((option) => option.value === "feature-one")).toHaveLength(0);
  });

  test("explicit interactive values skip both questions", async () => {
    let question_count = 0;
    const prompts = create_prompts({
      ask_name: async () => {
        question_count += 1;
        return "unused";
      },
      ask_dependency_owner: async () => {
        question_count += 1;
        return "unused";
      },
    });

    const instance = await resolve_session_instance(
      create_loaded_config(),
      parse_session_options(["-i", "--name", "feature-one", "-d"]),
      prompts,
      state_root(),
    );

    expect(question_count).toBe(0);
    expect(instance?.dependency_owner).toBe("feature-one");
    expect(instance?.dependencies.owns).toBe(true);
  });

  test("cancelling a prompt aborts before startup", async () => {
    const cancellations: string[] = [];
    const result = await resolve_session_instance(
      create_loaded_config(),
      parse_session_options(["-i"]),
      create_prompts({
        ask_name: async () => Symbol("cancel"),
        cancel: (message) => cancellations.push(message),
        is_cancel: (value) => typeof value === "symbol",
      }),
      state_root(),
    );

    expect(result).toBeNull();
    expect(cancellations).toEqual(["Startup cancelled."]);
  });
});
