import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as parse_toml } from "smol-toml";
import ts from "typescript";
import { parseDocument } from "yaml";

import type { Devtree_config, Loaded_devtree_config } from "./config.ts";
import { find_devtree_config, load_devtree_config } from "./config.ts";
import {
  get_config_expression,
  update_config_expression,
  update_config_text,
} from "./config-command.ts";
import { create_devtree_instance } from "./instance.ts";
import { slugify } from "./hostname.ts";
import { apply_devtree_yaml_config, load_devtree_yaml_config } from "./yaml-config.ts";

export type Setup_project = Awaited<ReturnType<typeof detect_setup_project>>;
export type Setup_choices = {
  project_name: string;
  package_manager: "pnpm" | "npm" | "yarn" | "bun";
  workflow: "scripts" | "mise";
  runner: "vite" | "vite-plus";
  task: string;
  provider: Devtree_config["env"]["provider"];
  access: "local" | "tailscale";
  routing_provider: "portless" | "caddy";
  hostname_suffix: string;
  base_domain: string;
  machine_name: string;
  port: number;
  managed_values: Array<{ key: string; value: string; source: "literal" | "url" }>;
  dependencies?: Devtree_config["dependencies"];
};
export type Setup_file = { path: string; before: string; after: string };

export async function detect_setup_project(start_dir = process.cwd()) {
  let loaded_config: Loaded_devtree_config | undefined;
  let repo_root: string;
  try {
    repo_root = find_devtree_config(start_dir).repo_root;
  } catch {
    repo_root = resolve(start_dir);
    while (!existsSync(resolve(repo_root, "package.json"))) {
      const parent = dirname(repo_root);
      if (parent === repo_root)
        throw new Error("Run setup inside a project with a package.json file.");
      repo_root = parent;
    }
  }
  if (existsSync(resolve(repo_root, "devtree.config.ts")))
    loaded_config = await load_devtree_config(repo_root);
  const package_path = resolve(repo_root, "package.json");
  const package_text = readFileSync(package_path, "utf8");
  const package_json = JSON.parse(package_text) as {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packages = { ...package_json.dependencies, ...package_json.devDependencies };
  const mise_path =
    ["mise.toml", ".mise.toml"].map((name) => resolve(repo_root, name)).find(existsSync) ??
    resolve(repo_root, "mise.toml");
  const mise_text = existsSync(mise_path) ? readFileSync(mise_path, "utf8") : "";
  const mise_config = parse_toml(mise_text) as {
    env?: { _?: { devtree?: { tools?: boolean }; path?: string[] } };
    tasks?: Record<string, { run?: string | string[] } | string>;
  };
  const configured_runner = loaded_config?.config.dev_server?.runner;
  const lockfile_managers = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ] as const;
  const detected_manager = lockfile_managers.find(([filename]) =>
    existsSync(resolve(repo_root, filename)),
  )?.[1];
  const package_manager = package_json.packageManager?.split("@")[0] ?? detected_manager ?? "npm";
  let runner: Setup_choices["runner"] = packages["vite-plus"] ? "vite-plus" : "vite";
  if (configured_runner === "vite" || configured_runner === "vite-plus") runner = configured_runner;
  const choices: Setup_choices = {
    project_name:
      loaded_config?.config.project_name ??
      (slugify(package_json.name ?? basename(repo_root)) || "app"),
    package_manager: ["pnpm", "npm", "yarn", "bun"].includes(package_manager)
      ? (package_manager as Setup_choices["package_manager"])
      : "npm",
    workflow: mise_text ? "mise" : "scripts",
    runner,
    task: typeof configured_runner === "object" ? configured_runner.task : "vite:serve",
    provider: loaded_config?.config.env.provider ?? (mise_text ? "process" : "dotenv"),
    access: loaded_config?.config.tailscale?.enabled ? "tailscale" : "local",
    routing_provider: loaded_config?.config.routing?.provider?.kind ?? "portless",
    hostname_suffix: loaded_config?.yaml_config?.merged.routing?.hostname_suffix ?? "",
    base_domain: loaded_config?.yaml_config?.merged.routing?.base_domain ?? "",
    machine_name: loaded_config?.yaml_config?.merged.routing?.machine_name ?? "",
    port: loaded_config?.config.routing?.port ?? loaded_config?.config.portless?.port ?? 1355,
    managed_values: [],
  };
  return {
    repo_root,
    loaded_config,
    package_path,
    package_text,
    package_json,
    packages,
    mise_path,
    mise_text,
    mise_config,
    choices,
  };
}

function append_mise_section(source: string, name: string, run: string) {
  return `${source.trimEnd()}\n\n[tasks.${JSON.stringify(name)}]\nrun = ${JSON.stringify(run)}\n`;
}

export function plan_setup_files(project: Setup_project, choices: Setup_choices) {
  const files: Setup_file[] = [];
  const add_file = (path: string, after: string) => {
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (after !== before) files.push({ path, before, after });
  };
  const config_path = resolve(project.repo_root, "devtree.config.ts");
  const package_name = project.packages.devtree ? "devtree" : "@mdulghier/devtree";
  let config_text = project.loaded_config
    ? readFileSync(config_path, "utf8")
    : `import { define_devtree_config } from ${JSON.stringify(package_name)};\n\nexport default define_devtree_config({\n  project_name: "app",\n  env: { provider: "dotenv", entries: () => [] },\n});\n`;

  const updates: Array<[string, unknown]> = [
    ["project_name", choices.project_name],
    ["env.provider", choices.provider],
    [
      "dev_server.runner",
      choices.workflow === "mise" ? { kind: "mise", task: choices.task } : choices.runner,
    ],
  ];
  if (choices.dependencies !== undefined) updates.push(["dependencies", choices.dependencies]);
  try {
    for (const [key, value] of updates)
      config_text = update_config_text(config_text, key, JSON.stringify(value));
    if (choices.managed_values.length) {
      const existing_entries = get_config_expression(config_text, "env.entries");
      const entries_type = ts.factory.createIndexedAccessTypeNode(
        ts.factory.createIndexedAccessTypeNode(
          ts.factory.createImportTypeNode(
            ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(package_name)),
            undefined,
            ts.factory.createIdentifier("Devtree_config"),
          ),
          ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral("env")),
        ),
        ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral("entries")),
      );
      const typed_entries = ts.factory.createSatisfiesExpression(
        ts.factory.createParenthesizedExpression(existing_entries),
        entries_type,
      );
      const context = ts.factory.createIdentifier("context");
      const entries = choices.managed_values.map(({ key, value, source }) =>
        ts.factory.createObjectLiteralExpression([
          ts.factory.createPropertyAssignment("kind", ts.factory.createStringLiteral("value")),
          ts.factory.createPropertyAssignment("key", ts.factory.createStringLiteral(key)),
          ts.factory.createPropertyAssignment(
            "value",
            source === "url"
              ? ts.factory.createPropertyAccessExpression(
                  ts.factory.createPropertyAccessExpression(context, "instance"),
                  "public_url",
                )
              : ts.factory.createStringLiteral(value),
          ),
        ]),
      );
      const callback = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [ts.factory.createParameterDeclaration(undefined, undefined, context)],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createArrayLiteralExpression(
          [
            ts.factory.createSpreadElement(
              ts.factory.createCallExpression(
                ts.factory.createParenthesizedExpression(typed_entries),
                undefined,
                (ts.isArrowFunction(existing_entries) ||
                  ts.isFunctionExpression(existing_entries)) &&
                  existing_entries.parameters.length === 0
                  ? []
                  : [context],
              ),
            ),
            ...entries,
          ],
          true,
        ),
      );
      config_text = update_config_expression(config_text, "env.entries", callback);
    }
  } catch (error) {
    throw new Error(
      `Cannot safely edit ${config_path}: ${String(error)}\nApply these settings to its exported configuration, then rerun setup:\n${updates.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}`,
    );
  }
  add_file(config_path, config_text);

  const yaml_config = load_devtree_yaml_config(project.repo_root);
  const update_yaml = (path: string, values: Array<[string[], unknown]>) => {
    const document = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "{}");
    for (const [key, value] of values)
      value === undefined ? document.deleteIn(key) : document.setIn(key, value);
    add_file(path, document.toString());
  };
  const tailscale = choices.access === "tailscale";
  update_yaml(yaml_config.project_path, [
    [["version"], 1],
    [["routing", "provider"], choices.routing_provider],
    [["routing", "port"], choices.port],
    [
      ["routing", "https"],
      tailscale ? false : (project.loaded_config?.config.routing?.https ?? false),
    ],
    [["routing", "base_domain"], tailscale ? choices.base_domain : undefined],
    [["routing", "machine_name"], undefined],
    [["routing", "hostname_suffix"], tailscale ? undefined : choices.hostname_suffix || undefined],
    [["tailscale", "enabled"], tailscale],
    [["tailscale", "mode"], tailscale ? "proxy" : "direct"],
  ]);
  if (tailscale || existsSync(yaml_config.local_path)) {
    update_yaml(yaml_config.local_path, [
      [["routing", "machine_name"], tailscale ? choices.machine_name : undefined],
      [["routing", "hostname_suffix"], undefined],
      [["routing", "base_domain"], undefined],
      [["routing", "provider"], undefined],
      [["routing", "port"], undefined],
      [["routing", "https"], undefined],
      [["tailscale", "enabled"], undefined],
      [["tailscale", "mode"], undefined],
    ]);
  }

  const package_json = { ...project.package_json, scripts: { ...project.package_json.scripts } };
  if (choices.workflow === "scripts") {
    const script_name =
      !package_json.scripts.dev || package_json.scripts.dev === "devtree dev" ? "dev" : "devtree";
    if (package_json.scripts[script_name] && package_json.scripts[script_name] !== "devtree dev")
      throw new Error(
        `package.json script ${script_name} already exists. Add a script running devtree dev, then rerun setup.`,
      );
    package_json.scripts[script_name] = "devtree dev";
  } else {
    let mise_text = project.mise_text;
    const existing_path = project.mise_config.env?._?.path;
    if (
      existing_path &&
      !existing_path.includes("./node_modules/.bin") &&
      !existing_path.includes("node_modules/.bin")
    ) {
      throw new Error(
        `Add "./node_modules/.bin" to env._.path in ${project.mise_path}, then rerun setup.`,
      );
    }
    if (!existing_path) {
      const env_section = /^\[\s*(?:env|"env"|'env')\s*\]([^\n]*)(?:\n|$)/mu;
      mise_text = env_section.test(mise_text)
        ? mise_text.replace(env_section, '$&_.path = ["./node_modules/.bin"]\n')
        : `${mise_text.trimEnd()}\n\n[env]\n_.path = ["./node_modules/.bin"]\n`;
    }
    if (!project.mise_config.env?._?.devtree)
      mise_text = `${mise_text.trimEnd()}\n\n[env._.devtree]\ntools = true\n`;
    else if (!project.mise_config.env._.devtree.tools)
      throw new Error(
        `Set tools = true in the existing env._.devtree directive in ${project.mise_path}, then rerun setup.`,
      );
    const existing_task = project.mise_config.tasks?.[choices.task];
    if (existing_task) {
      const run = typeof existing_task === "string" ? existing_task : existing_task.run;
      if (/\bdevtree\b/u.test(String(run)))
        throw new Error("The server task must launch Vite, not devtree dev (that would recurse).");
    } else {
      mise_text = append_mise_section(
        mise_text,
        choices.task,
        `${choices.runner === "vite" ? "vite" : "vp"} dev`,
      );
    }
    const current_tasks = (parse_toml(mise_text) as typeof project.mise_config).tasks;
    const dev_task = current_tasks?.dev;
    const dev_run = typeof dev_task === "string" ? dev_task : dev_task?.run;
    if (!dev_task) mise_text = append_mise_section(mise_text, "dev", "devtree dev");
    else if (dev_run !== "devtree dev") {
      const existing_devtree = current_tasks?.devtree;
      const existing_run =
        typeof existing_devtree === "string" ? existing_devtree : existing_devtree?.run;
      if (existing_devtree && existing_run !== "devtree dev")
        throw new Error(
          "mise task devtree already exists. Keep a separate task running devtree dev.",
        );
      if (!existing_devtree) mise_text = append_mise_section(mise_text, "devtree", "devtree dev");
    }
    parse_toml(mise_text);
    add_file(project.mise_path, mise_text);
  }
  if (
    JSON.stringify(package_json) !==
    JSON.stringify({ ...project.package_json, scripts: { ...project.package_json.scripts } })
  )
    add_file(project.package_path, `${JSON.stringify(package_json, null, 2)}\n`);
  return files;
}

export function preview_setup_url(project: Setup_project, choices: Setup_choices) {
  const config = apply_devtree_yaml_config(
    project.loaded_config?.config ?? {
      project_name: choices.project_name,
      env: { provider: choices.provider, entries: () => [] },
    },
    {
      routing: {
        provider: choices.routing_provider,
        port: choices.port,
        https:
          choices.access === "tailscale"
            ? false
            : (project.loaded_config?.config.routing?.https ?? false),
        ...(choices.access === "tailscale"
          ? { base_domain: choices.base_domain, machine_name: choices.machine_name }
          : { hostname_suffix: choices.hostname_suffix || undefined }),
      },
    },
  );
  return create_devtree_instance({
    config: { ...config, project_name: choices.project_name },
    config_path: "",
    repo_root: project.repo_root,
  }).public_url;
}
