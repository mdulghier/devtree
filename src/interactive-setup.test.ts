import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as prompts from "@clack/prompts";
import { run_command_inherit_async } from "./process.ts";
import { run_interactive_setup } from "./interactive-setup.ts";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

const original_stdin_tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const original_stdout_tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
function set_tty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}
vi.mock("./process.ts", async (import_original) => ({
  ...(await import_original<typeof import("./process.ts")>()),
  command_exists: vi.fn(() => true),
  run_command_inherit_async: vi.fn(async () => 0),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [
    [process.stdin, original_stdin_tty],
    [process.stdout, original_stdout_tty],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
});

describe("interactive setup", { timeout: 15_000 }, () => {
  test("noninteractive terminals receive a useful command without requiring configuration", async () => {
    set_tty(false);
    await expect(run_interactive_setup("/no-project")).rejects.toThrow(
      "Guided setup needs an interactive terminal",
    );
  });

  test("cancelling the review of a fresh project writes no configuration", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "devtree-guide-cancel-"));
    const package_text = JSON.stringify({
      name: "fresh",
      devDependencies: { vite: "*", portless: "*" },
    });
    writeFileSync(resolve(root, "package.json"), package_text);
    set_tty(true);
    vi.mocked(prompts.text).mockImplementation(async (options) => options.initialValue ?? "");
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    vi.mocked(prompts.select).mockImplementation(async (options) =>
      options.message === "Apply this setup?" ? "cancel" : options.initialValue!,
    );
    try {
      await run_interactive_setup(root);
      expect(readdirSync(root)).toEqual(["package.json"]);
      expect(readFileSync(resolve(root, "package.json"), "utf8")).toBe(package_text);
      expect(prompts.cancel).toHaveBeenCalledWith("Setup cancelled. No files were changed.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("applying and rerunning a fresh setup preserves scripts and distinguishes ready from verified", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "devtree-guide-apply-"));
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fresh",
        scripts: { build: "vite build", dev: "vite" },
        devDependencies: { devtree: "*", vite: "*", portless: "*" },
      }),
    );
    const local_package = resolve(root, "node_modules/devtree");
    mkdirSync(local_package, { recursive: true });
    writeFileSync(
      resolve(local_package, "package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    writeFileSync(
      resolve(local_package, "index.js"),
      "export const define_devtree_config = config => config;",
    );
    vi.stubEnv("HOME", resolve(root, "home"));
    set_tty(true);
    vi.mocked(prompts.text).mockImplementation(async (options) => options.initialValue ?? "");
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    vi.mocked(prompts.select).mockImplementation(async (options) => options.initialValue!);
    try {
      await run_interactive_setup(root);
      const first_package = readFileSync(resolve(root, "package.json"), "utf8");
      const first_config = readFileSync(resolve(root, "devtree.config.ts"), "utf8");
      await run_interactive_setup(root);
      expect(readFileSync(resolve(root, "package.json"), "utf8")).toBe(first_package);
      expect(readFileSync(resolve(root, "devtree.config.ts"), "utf8")).toBe(first_config);
      expect(JSON.parse(first_package).scripts).toEqual({
        build: "vite build",
        dev: "vite",
        devtree: "devtree dev",
      });
      expect(run_command_inherit_async).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["doctor", "--fix"]),
        { cwd: root },
      );
      expect(prompts.outro).toHaveBeenCalledWith(
        expect.stringContaining("Application has not been verified"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
