import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const cli_path = resolve(import.meta.dirname, "cli.ts");
const tsx_loader = createRequire(import.meta.url).resolve("tsx");

function fixture(provider = "process") {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "devtree-persistent-")));
  const bin_path = resolve(root, "bin");
  mkdirSync(bin_path);
  writeFileSync(
    resolve(bin_path, "vite"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('server.json', JSON.stringify({env:process.env,args:process.argv.slice(2)}));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(root, "devtree.config.ts"),
    `export default {
    project_name: "persistent", portless: { enabled: false }, dev_server: { runner: "vite" },
    env: { provider: ${JSON.stringify(provider)}, entries: ({instance, dependencies}) => [
      {kind: "value", key: "PUBLIC_URL", value: instance.public_url},
      {kind: "value", key: "APP_PORT", value: String(instance.endpoints.app.target_port)},
      {kind: "value", key: "DB_PORT", value: String(dependencies.allocate_port("database", 20000))},
      {kind: "value", key: "QUOTED", value: "space ' quote\\nsecond line"}
    ] }
  };`,
  );
  const env = {
    ...process.env,
    HOME: resolve(root, "home"),
    PATH: `${bin_path}:${process.env.PATH}`,
    SECRET_PARENT_VALUE: "do-not-export",
  };
  const args = (options: string[]) => ["--import", tsx_loader, cli_path, ...options];
  return {
    root,
    env,
    run: (options: string[]) =>
      spawnSync(process.execPath, args(options), { cwd: root, env, encoding: "utf8" }),
    spawn: (options: string[]) =>
      spawn(process.execPath, args(options), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function wait_for_file(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  throw new Error(`Server did not write ${path}`);
}

describe("persistent session CLI", () => {
  test("exports, starts, stops and restarts with the same assignments and no env file", async () => {
    const project = fixture();
    let server: ReturnType<typeof project.spawn> | undefined;
    try {
      const initial = project.run(["env", "--json", "--name", "billing", "-d"]);
      expect(initial.status, initial.stderr).toBe(0);
      const values = JSON.parse(initial.stdout);
      expect(values.DEVTREE_SESSION_NAME).toBe("billing");
      expect(values.SECRET_PARENT_VALUE).toBeUndefined();
      expect(values.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBeUndefined();
      expect(JSON.parse(project.run(["env", "--json"]).stdout)).toEqual(values);
      expect(JSON.parse(project.run(["list", "--json"]).stdout)[0].status).toBe("stopped");
      const exported = project.run(["env", "--shell"]);
      const sourced = spawnSync(
        "sh",
        [
          "-c",
          `${exported.stdout}\nexec '${process.execPath}' -e 'process.stdout.write(JSON.stringify({QUOTED:process.env.QUOTED,APP_PORT:process.env.APP_PORT}))'`,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(sourced.stdout)).toEqual({
        QUOTED: values.QUOTED,
        APP_PORT: values.APP_PORT,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        rmSync(resolve(project.root, "server.json"), { force: true });
        server = project.spawn(["dev"]);
        const startup = await wait_for_file(resolve(project.root, "server.json"));
        for (const [key, value] of Object.entries(values))
          expect(startup.env[key], key).toBe(value);
        expect(startup.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(
          values.DEVTREE_PUBLIC_HOSTNAME,
        );
        expect(startup.args).toContain(values.APP_PORT);
        expect(project.run(["session", "remove"]).status).toBe(1);
        expect(project.run(["env", "--json", "--name", "other"]).status).toBe(1);
        const exit = once(server, "exit");
        server.kill("SIGTERM");
        await exit;
        server = undefined;
        expect(JSON.parse(project.run(["list", "--json"]).stdout)[0].status).toBe("stopped");
        expect(JSON.parse(project.run(["env", "--json"]).stdout)).toEqual(values);
      }
      project.run(["env", "write"]);
      expect(readdirSync(project.root)).not.toContain(".env.local");
      expect(project.run(["session", "remove"]).status).toBe(0);
      expect(JSON.parse(project.run(["list", "--json"]).stdout)).toEqual([]);
    } finally {
      if (server) {
        const exit = once(server, "exit");
        server.kill("SIGTERM");
        await exit;
      }
      project.cleanup();
    }
  }, 20_000);

  test("concurrent exports serialize creation and port allocation", async () => {
    const project = fixture();
    try {
      const children = Array.from({ length: 8 }, () => project.spawn(["env", "--json"]));
      const values = await Promise.all(
        children.map(
          (child) =>
            new Promise<Record<string, string>>((done, fail) => {
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (chunk) => {
                stdout += chunk;
              });
              child.stderr.on("data", (chunk) => {
                stderr += chunk;
              });
              child.on("error", fail);
              child.on("exit", (code) =>
                code === 0 ? done(JSON.parse(stdout)) : fail(new Error(stderr)),
              );
            }),
        ),
      );
      expect(new Set(values.map((value) => value.APP_PORT)).size).toBe(1);
      expect(JSON.parse(project.run(["list", "--json"]).stdout)).toHaveLength(1);
      const other = JSON.parse(project.run(["env", "--json", "--name", "other", "-d"]).stdout);
      expect(other.APP_PORT).not.toBe(values[0].APP_PORT);
      expect(other.DB_PORT).not.toBe(values[0].DB_PORT);
      expect(JSON.parse(project.run(["env", "--json"]).stdout)).toEqual(other);
    } finally {
      project.cleanup();
    }
  }, 15_000);

  test("occupied assignments fail startup and retain the stopped session", async () => {
    const project = fixture();
    const listener = createServer();
    try {
      const values = JSON.parse(project.run(["env", "--json"]).stdout);
      listener.listen(Number(values.APP_PORT), "127.0.0.1");
      await once(listener, "listening");
      const result = project.run(["dev"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is unavailable");
      expect(JSON.parse(project.run(["list", "--json"]).stdout)[0].status).toBe("stopped");
      expect(JSON.parse(project.run(["env", "--json"]).stdout)).toEqual(values);
    } finally {
      listener.close();
      project.cleanup();
    }
  });
});
