import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import ts from "typescript";
import { parse as parse_toml } from "smol-toml";
import { describe, expect, test } from "vite-plus/test";
import { detect_setup_project, plan_setup_files, preview_setup_url } from "./setup-project.ts";

function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "devtree-guide-"));
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "fresh-vite",
      scripts: { build: "vite build", dev: "vite" },
      devDependencies: { vite: "8.0.1", devtree: "*" },
    }),
  );
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(root, name), content);
  return root;
}

describe("guided setup planning", { timeout: 15_000 }, () => {
  test("a fresh Vite checkout can review setup without writing anything, then rerun without duplicate settings", async () => {
    const root = fixture();
    try {
      const project = await detect_setup_project(root);
      const before = readdirSync(root);
      const choices = {
        ...project.choices,
        workflow: "mise" as const,
        provider: "process" as const,
      };
      const files = plan_setup_files(project, choices);
      expect(readdirSync(root)).toEqual(before);
      const mise = files.find((file) => file.path.endsWith("mise.toml"))!;
      expect(parse_toml(mise.after)).toMatchObject({
        env: { _: { devtree: { tools: true } } },
        tasks: { "vite:serve": { run: "vite dev" }, dev: { run: "devtree dev" } },
      });
      expect(preview_setup_url(project, choices)).toBe("http://fresh-vite.localhost:1355");
      const config = files.find((file) => file.path.endsWith("devtree.config.ts"))!;
      expect(config.after).toContain('provider: "process"');
      // Pretend the reviewed writes were applied, without requiring project dependencies for this pure planner test.
      const rerun_project = {
        ...project,
        mise_text: mise.after,
        mise_config: parse_toml(mise.after) as typeof project.mise_config,
      };
      expect(
        plan_setup_files(rerun_project, choices).find((file) => file.path.endsWith("mise.toml"))
          ?.after,
      ).toBe(mise.after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing TypeScript callbacks, scripts and TOML settings survive setup", async () => {
    const root = fixture({
      "devtree.config.ts": `const custom = "preserved";\nexport default {project_name:"existing",env:{provider:"dotenv",entries:({instance})=>[{kind:"value",key:"URL",value:instance.public_url}]},hooks:{pre_dev:[{command:["echo",custom]}]}};\n`,
      "mise.toml":
        '# keep this comment\n[tools]\nnode = "24"\n[tasks.build]\nrun = "vite build"\n[tasks.dev]\nrun = "echo original"\n',
    });
    try {
      const project = await detect_setup_project(root);
      const choices = {
        ...project.choices,
        workflow: "mise" as const,
        managed_values: [{ key: "ADDED", value: "literal ' value", source: "literal" as const }],
      };
      const files = plan_setup_files(project, choices);
      const config = files.find((file) => file.path.endsWith("devtree.config.ts"))!.after;
      expect(config).toContain('const custom = "preserved"');
      expect(config).toContain('key: "ADDED"');
      expect(config).toContain('key: "URL"');
      expect(config).toContain("hooks:");
      const mise = files.find((file) => file.path.endsWith("mise.toml"))!.after;
      expect(mise).toContain("# keep this comment");
      expect(parse_toml(mise)).toMatchObject({
        tools: { node: "24" },
        tasks: { dev: { run: "echo original" }, devtree: { run: "devtree dev" } },
      });
      expect(readFileSync(resolve(root, "mise.toml"), "utf8")).toBe(project.mise_text);
      expect(files.some((file) => file.path.endsWith("package.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("executable config that cannot be edited safely produces precise edits and no writes", async () => {
    const root = fixture({
      "devtree.config.ts":
        'const config = {project_name:"custom",env:{provider:"dotenv",entries:()=>[]}}; export default config;',
    });
    try {
      mkdirSync(resolve(root, "nested"));
      const project = await detect_setup_project(resolve(root, "nested"));
      expect(project.repo_root).toBe(root);
      expect(() => plan_setup_files(project, { ...project.choices, provider: "process" })).toThrow(
        'env.provider: "process"',
      );
      expect(readdirSync(root).sort()).toEqual(["devtree.config.ts", "nested", "package.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("adding managed entries preserves TypeScript contextual typing", async () => {
    const root = fixture({
      "devtree.config.ts":
        'import {define_devtree_config} from "devtree"; export default define_devtree_config({project_name:"typed",env:{provider:"process",entries:({instance})=>[{kind:"value",key:"OLD",value:instance.public_url}]}});',
    });
    const local_package = resolve(root, "node_modules/devtree");
    mkdirSync(local_package, { recursive: true });
    writeFileSync(
      resolve(local_package, "package.json"),
      JSON.stringify({
        name: "devtree",
        type: "module",
        exports: { types: "./index.d.ts", import: "./index.js" },
      }),
    );
    writeFileSync(
      resolve(local_package, "index.js"),
      "export const define_devtree_config = config => config;",
    );
    writeFileSync(
      resolve(local_package, "index.d.ts"),
      `export {define_devtree_config, type Devtree_config} from ${JSON.stringify(resolve(import.meta.dirname, "config.ts"))};`,
    );
    try {
      const project = await detect_setup_project(root);
      const files = plan_setup_files(project, {
        ...project.choices,
        managed_values: [{ key: "NEW", value: "", source: "url" }],
      });
      for (const file of files) writeFileSync(file.path, file.after);
      const program = ts.createProgram([resolve(root, "devtree.config.ts")], {
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      });
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      expect(errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
