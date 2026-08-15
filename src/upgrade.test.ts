import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { analyze_upgrade_config, migrate_upgrade_config } from "./upgrade-config.ts";
import { run_upgrade_command, type Upgrade_prompts } from "./upgrade.ts";

const legacy_config = `import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "web-ui",
  namespace: "exo",
  routing: {
    hostname: ({ app_name, worktree_slug }) =>
      \`${"${worktree_slug ?? app_name}"}.example.com\`,
  },
  env: {
    provider: "dotenv",
    entries: ({ instance }) => {
      const database_port = instance.allocate_port("postgres", 5400);
      const api_port = instance.allocate_port("api", 3000);
      return [
        { kind: "value", key: "DATABASE_PORT", value: String(database_port) },
        { kind: "value", key: "API_PORT", value: String(api_port) },
      ];
    },
  },
});
`;

const current_config = `import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "acme-cloud",
  endpoints: {
    ui: { primary: true, target: { kind: "dev-server" } },
  },
  env: {
    provider: "dotenv",
    entries: ({ instance }) => [
      { kind: "value", key: "API_PORT", value: String(instance.allocate_port("api")) },
    ],
  },
});
`;

function create_prompts(overrides: Partial<Upgrade_prompts> = {}) {
  return {
    ask_project_name: async () => "acme-cloud",
    ask_endpoint_name: async () => "ui",
    select_allocations: async (allocations) => [allocations[0]!.id],
    confirm_apply: async () => true,
    cancel: () => undefined,
    intro: () => undefined,
    is_cancel: () => false,
    note: () => undefined,
    outro: () => undefined,
    ...overrides,
  } satisfies Upgrade_prompts;
}

describe("Devtree upgrade config migration", () => {
  test("finds legacy keys, custom routing, and selectable port allocations", () => {
    const analysis = analyze_upgrade_config(legacy_config);

    expect(analysis).toMatchObject({
      has_legacy_keys: true,
      has_endpoints: false,
      initial_project_name: "web-ui",
      has_custom_hostname: true,
    });
    expect(analysis.allocations).toHaveLength(2);
    expect(analysis.allocations.every((allocation) => allocation.automatable)).toBe(true);
  });

  test("rewrites only the selected dependency ports", () => {
    const analysis = analyze_upgrade_config(legacy_config);
    const migrated_config = migrate_upgrade_config(legacy_config, {
      project_name: "acme-cloud",
      endpoint_name: "ui",
      dependency_allocation_ids: [analysis.allocations[0]!.id],
    });

    expect(migrated_config).toContain('project_name: "acme-cloud"');
    expect(migrated_config).not.toMatch(/^\s*(app_name|namespace):/mu);
    expect(migrated_config).toContain("endpoints:");
    expect(migrated_config).toContain('kind: "dev-server"');
    expect(migrated_config).toContain("entries: ({ instance, dependencies }) =>");
    expect(migrated_config).toContain('dependencies.allocate_port("postgres", 5400)');
    expect(migrated_config).toContain('instance.allocate_port("api", 3000)');
  });

  test("supports configs wrapped in TypeScript satisfies expressions", () => {
    const wrapped_config = `export default ({
  app_name: "wrapped-app" as const,
  routing: ({ hostname: () => "wrapped.localhost" } as const),
} satisfies Record<string, unknown>);
`;
    const analysis = analyze_upgrade_config(wrapped_config);
    const migrated_config = migrate_upgrade_config(wrapped_config, {
      project_name: "wrapped-project",
      endpoint_name: "ui",
      dependency_allocation_ids: [],
    });

    expect(analysis.initial_project_name).toBe("wrapped-app");
    expect(analysis.has_custom_hostname).toBe(true);
    expect(migrated_config).toContain('project_name: "wrapped-project"');
    expect(migrated_config).toContain("endpoints:");
  });
});

describe("Devtree upgrade command", () => {
  test("does nothing to an already-upgraded config", async () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-current-test-"));
    const repo_root = resolve(test_root, "repo");
    const state_root = resolve(test_root, "state");
    const config_path = resolve(repo_root, "devtree.config.ts");

    try {
      mkdirSync(repo_root, { recursive: true });
      writeFileSync(config_path, current_config);

      const result = await run_upgrade_command(repo_root, config_path, {
        prompts: create_prompts({
          confirm_apply: async () => {
            throw new Error("An idempotent upgrade must not ask for confirmation.");
          },
        }),
        state_root,
      });

      expect(result).toEqual({ upgraded: false, manual_steps: [] });
      expect(readFileSync(config_path, "utf8")).toBe(current_config);
      expect(existsSync(resolve(state_root, "backups"))).toBe(false);
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });

  test("backs up config, archives legacy state, and reports manual work", async () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-test-"));
    const repo_root = resolve(test_root, "repo");
    const state_root = resolve(test_root, "state");
    const config_path = resolve(repo_root, "devtree.config.ts");
    const session_path = resolve(state_root, "sessions", "legacy.json");

    try {
      mkdirSync(resolve(state_root, "sessions"), { recursive: true });
      mkdirSync(repo_root, { recursive: true });
      writeFileSync(config_path, legacy_config);
      writeFileSync(
        resolve(state_root, "projects.json"),
        `${JSON.stringify([
          {
            registry_namespace: "exo",
            compose_project: "exo-123-services",
            worktree_path: "/deleted/worktree",
            dependency_name: "services",
          },
        ])}\n`,
      );
      writeFileSync(
        session_path,
        `${JSON.stringify({
          version: 1,
          controller_pid: 999_999_999,
          app_name: "web-ui",
          worktree_slug: "feature-x",
        })}\n`,
      );
      writeFileSync(
        resolve(state_root, "routing-state.json"),
        '{"version":1,"instances":{},"tailscale_mappings":{}}\n',
      );

      const result = await run_upgrade_command(repo_root, config_path, {
        prompts: create_prompts(),
        state_root,
        now: new Date("2026-08-14T12:34:56.000Z"),
      });

      expect(result.upgraded).toBe(true);
      expect(readFileSync(config_path, "utf8")).toContain('project_name: "acme-cloud"');
      expect(result.config_backup_path).toBe(
        resolve(state_root, "backups", "upgrade-0.5-20260814T123456Z", "devtree.config.ts"),
      );
      expect(readFileSync(result.config_backup_path!, "utf8")).toBe(legacy_config);
      expect(existsSync(session_path)).toBe(false);
      expect(
        existsSync(
          resolve(state_root, "backups", "upgrade-0.5-20260814T123456Z", "sessions", "legacy.json"),
        ),
      ).toBe(true);
      expect(existsSync(resolve(state_root, "projects.json"))).toBe(false);
      expect(result.manual_steps.join("\n")).toContain("custom hostname");
      expect(result.manual_steps.join("\n")).toContain("exo-123-services");
      expect(result.manual_steps.join("\n")).toContain('instance.allocate_port("api", 3000)');
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });

  test("cancellation leaves config and state untouched", async () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-cancel-test-"));
    const repo_root = resolve(test_root, "repo");
    const state_root = resolve(test_root, "state");
    const config_path = resolve(repo_root, "devtree.config.ts");

    try {
      mkdirSync(repo_root, { recursive: true });
      writeFileSync(config_path, legacy_config);

      const result = await run_upgrade_command(repo_root, config_path, {
        prompts: create_prompts({ confirm_apply: async () => false }),
        state_root,
      });

      expect(result.upgraded).toBe(false);
      expect(readFileSync(config_path, "utf8")).toBe(legacy_config);
      expect(existsSync(resolve(state_root, "backups"))).toBe(false);
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });

  test("refuses to upgrade while a registered session is alive", async () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-live-test-"));
    const repo_root = resolve(test_root, "repo");
    const state_root = resolve(test_root, "state");
    const config_path = resolve(repo_root, "devtree.config.ts");

    try {
      mkdirSync(resolve(state_root, "sessions"), { recursive: true });
      mkdirSync(repo_root, { recursive: true });
      writeFileSync(config_path, legacy_config);
      writeFileSync(
        resolve(state_root, "sessions", "live.json"),
        `${JSON.stringify({
          version: 1,
          controller_pid: process.pid,
          app_name: "web-ui",
          worktree_slug: null,
        })}\n`,
      );

      await expect(
        run_upgrade_command(repo_root, config_path, {
          prompts: create_prompts(),
          state_root,
        }),
      ).rejects.toThrow("sessions are running");
      expect(readFileSync(config_path, "utf8")).toBe(legacy_config);
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });

  test("archives legacy registry entries without touching current entries", async () => {
    const test_root = mkdtempSync(resolve(tmpdir(), "devtree-upgrade-state-test-"));
    const repo_root = resolve(test_root, "repo");
    const state_root = resolve(test_root, "state");
    const config_path = resolve(repo_root, "devtree.config.ts");
    const current_entry = {
      version: 2,
      project_name: "acme-cloud",
      dependency_owner: "default",
      compose_project: "acme-cloud-default-services",
      worktree_path: repo_root,
      dependency_name: "services",
      updated_at: "2026-08-14T12:00:00.000Z",
    };
    const legacy_entry = {
      registry_namespace: "acme",
      compose_project: "acme-feature-services",
      worktree_path: "/deleted/worktree",
      dependency_name: "services",
    };

    try {
      mkdirSync(repo_root, { recursive: true });
      mkdirSync(state_root, { recursive: true });
      writeFileSync(config_path, current_config);
      writeFileSync(
        resolve(state_root, "projects.json"),
        `${JSON.stringify([legacy_entry, current_entry])}\n`,
      );

      const result = await run_upgrade_command(repo_root, config_path, {
        prompts: create_prompts(),
        state_root,
        now: new Date("2026-08-14T12:34:56.000Z"),
      });

      expect(result.upgraded).toBe(true);
      expect(result.config_backup_path).toBeUndefined();
      expect(readFileSync(config_path, "utf8")).toBe(current_config);
      expect(JSON.parse(readFileSync(resolve(state_root, "projects.json"), "utf8"))).toEqual([
        current_entry,
      ]);
      expect(
        JSON.parse(
          readFileSync(
            resolve(state_root, "backups", "upgrade-0.5-20260814T123456Z", "projects.json"),
            "utf8",
          ),
        ),
      ).toEqual([legacy_entry]);
    } finally {
      rmSync(test_root, { force: true, recursive: true });
    }
  });
});
