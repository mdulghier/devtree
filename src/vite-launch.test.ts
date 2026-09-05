import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { build_development_command } from "./command-builder.ts";

async function unused_port() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function request_host(port: number, hostname: string) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", headers: { Host: hostname } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => done({ status: response.statusCode!, body }));
      },
    );
    req.on("error", fail);
    req.setTimeout(1000, () => req.destroy(new Error("Request timed out")));
    req.end();
  });
}

describe("Vite launch contract", () => {
  test.each(["vite", "vite-plus"] as const)(
    "%s allows the public hostname and rejects unrelated hosts",
    async (runner) => {
      const root = mkdtempSync(resolve(tmpdir(), "devtree-vite-launch-"));
      writeFileSync(
        resolve(root, "index.html"),
        "<html><body>devtree launch verified</body></html>",
      );
      writeFileSync(
        resolve(root, "package.json"),
        JSON.stringify({
          name: "devtree-launch-fixture",
          type: "module",
          devDependencies: { "vite-plus": "*", vite: "*" },
        }),
      );
      symlinkSync(
        resolve(import.meta.dirname, "..", "node_modules"),
        resolve(root, "node_modules"),
        "dir",
      );
      const port = await unused_port();
      const [command, ...args] = build_development_command({
        runner,
        extra_args: [],
        vite_port: port,
        use_varlock: false,
      });
      const child = spawn(
        resolve(import.meta.dirname, "..", "node_modules", ".bin", command),
        args,
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "development",
            __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "session.devtree.example",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const exit = once(child, "exit");
      try {
        let response: Awaited<ReturnType<typeof request_host>> | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            response = await request_host(port, "session.devtree.example");
            break;
          } catch {
            if (child.exitCode !== null) throw new Error(output);
            await new Promise((done) => setTimeout(done, 50));
          }
        }
        expect(response?.status, output).toBe(200);
        expect(response!.body).toContain("devtree launch verified");
        const rejected = await request_host(port, "unrelated.example");
        expect(rejected.status).toBe(403);
      } finally {
        child.kill("SIGTERM");
        await exit;
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
