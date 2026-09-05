import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { build_development_command } from "./command-builder.ts";

const has_mise = spawnSync("mise", ["--version"], { stdio: "ignore" }).status === 0;
const tsx_loader = createRequire(import.meta.url).resolve("tsx");

describe("mise integration", () => {
  test.skipIf(!has_mise)(
    "installs a stable adapter, updates it, and loads each checkout's local CLI without caching",
    () => {
      const root = mkdtempSync(resolve(tmpdir(), "devtree-mise-test-"));
      const installation = resolve(root, "installation");
      mkdirSync(resolve(installation, "src"), { recursive: true });
      for (const name of ["mise.ts", "process.ts"])
        cpSync(resolve(import.meta.dirname, name), resolve(installation, "src", name));
      cpSync(resolve(import.meta.dirname, "..", "mise"), resolve(installation, "mise"), {
        recursive: true,
      });
      writeFileSync(resolve(installation, "package.json"), '{"type":"module"}');
      writeFileSync(
        resolve(installation, "install.mjs"),
        'import {install_mise_adapter} from "./src/mise.ts"; install_mise_adapter();',
      );
      const env = {
        ...process.env,
        HOME: resolve(root, "home"),
        MISE_DATA_DIR: resolve(root, "data"),
        MISE_CONFIG_DIR: resolve(root, "config"),
        MISE_CACHE_DIR: resolve(root, "cache"),
        MISE_STATE_DIR: resolve(root, "state"),
        MISE_GLOBAL_CONFIG_FILE: resolve(root, "global.toml"),
        MISE_TRUSTED_CONFIG_PATHS: root,
      };
      const run = (command: string, args: string[], cwd = root) =>
        spawnSync(command, args, { cwd, env, encoding: "utf8" });
      try {
        const install = () =>
          run(process.execPath, ["--import", tsx_loader, resolve(installation, "install.mjs")]);
        expect(install().status).toBe(0);
        const stable_path = resolve(root, "home/.devtree/mise/devtree");
        writeFileSync(resolve(stable_path, "metadata.lua"), "outdated");
        expect(install().status).toBe(0);
        expect(readFileSync(resolve(stable_path, "metadata.lua"), "utf8")).toContain(
          'PLUGIN.name = "devtree"',
        );
        rmSync(installation, { recursive: true, force: true });
        expect(existsSync(resolve(stable_path, "hooks/mise_env.lua"))).toBe(true);
        for (const name of ["first ' checkout", "second checkout"]) {
          const checkout = resolve(root, name);
          const local_package = resolve(checkout, "node_modules/devtree");
          mkdirSync(local_package, { recursive: true });
          mkdirSync(resolve(checkout, "nested"));
          writeFileSync(resolve(checkout, "devtree.config.ts"), "export default {};");
          writeFileSync(resolve(checkout, "selection.txt"), name);
          writeFileSync(
            resolve(checkout, "mise.toml"),
            '[env]\n_.devtree = {tools=true}\n[tasks."vite:serve"]\nrun = "node server.mjs"\n',
          );
          writeFileSync(
            resolve(local_package, "package.json"),
            JSON.stringify({ name: "@mdulghier/devtree", bin: { devtree: "cli.mjs" } }),
          );
          writeFileSync(
            resolve(local_package, "cli.mjs"),
            `import {readFileSync} from 'node:fs'; if (process.argv.slice(2).join(' ') !== 'env --json') process.exit(8); console.log(JSON.stringify({ LOCAL_VERSION: ${JSON.stringify(name)}, SELECTION: readFileSync('selection.txt','utf8') }));`,
          );
          const exported = run("mise", ["env", "--json"], resolve(checkout, "nested"));
          expect(exported.status, exported.stderr).toBe(0);
          expect(JSON.parse(exported.stdout)).toMatchObject({
            LOCAL_VERSION: name,
            SELECTION: name,
          });
          writeFileSync(resolve(checkout, "selection.txt"), "changed");
          expect(JSON.parse(run("mise", ["env", "--json"], checkout).stdout).SELECTION).toBe(
            "changed",
          );
          writeFileSync(
            resolve(checkout, "server.mjs"),
            "console.log(JSON.stringify({args:process.argv.slice(2),selection:process.env.SELECTION,allowed:process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS}));",
          );
          const [command, ...args] = build_development_command({
            runner: { kind: "mise", task: "vite:serve" },
            extra_args: [],
            vite_port: 54321,
            use_varlock: false,
          });
          const server = spawnSync(command, args, {
            cwd: checkout,
            encoding: "utf8",
            env: { ...env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "app.example" },
          });
          expect(server.status, server.stderr).toBe(0);
          expect(JSON.parse(server.stdout)).toEqual({
            args: [
              "--host",
              "127.0.0.1",
              "--clearScreen",
              "false",
              "--port",
              "54321",
              "--strictPort",
            ],
            selection: "changed",
            allowed: "app.example",
          });
          rmSync(local_package, { recursive: true, force: true });
          const missing = run("mise", ["env", "--json"], checkout);
          expect(missing.status).not.toBe(0);
          expect(missing.stderr).toContain("Install this project's dependencies");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test("wraps the whole mise command with Varlock", () => {
    expect(
      build_development_command({
        runner: { kind: "mise", task: "vite:serve" },
        extra_args: ["--open"],
        vite_port: 54321,
        use_varlock: true,
      }),
    ).toEqual([
      "varlock",
      "run",
      "--",
      "mise",
      "run",
      "vite:serve",
      "--",
      "--host",
      "127.0.0.1",
      "--clearScreen",
      "false",
      "--open",
      "--port",
      "54321",
      "--strictPort",
    ]);
  });
});
