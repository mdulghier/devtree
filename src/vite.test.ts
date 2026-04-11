import { afterEach, describe, expect, test } from "vite-plus/test";

import { devtree_vite_plugins } from "./vite.ts";
import type { Devtree_config } from "./config.ts";

const base_config: Devtree_config = {
  app_name: "demo-app",
  env: {
    provider: "dotenv",
    entries: () => [],
  },
};

function run_config_hook(plugin: { config?: unknown }, user_config: Record<string, unknown>) {
  const config_hook = plugin.config as
    | ((config: Record<string, unknown>, env?: Record<string, unknown>) => unknown)
    | {
        handler: (config: Record<string, unknown>, env?: Record<string, unknown>) => unknown;
      }
    | undefined;

  if (!config_hook) {
    return undefined;
  }

  if (typeof config_hook === "function") {
    return config_hook(user_config, { command: "serve" });
  }

  return config_hook.handler(user_config, { command: "serve" });
}

afterEach(() => {
  delete process.env.DEVTREE_TAILSCALE_HOST;
});

describe("devtree_vite_plugins", () => {
  test("adds the tailscale host to Vite allowed hosts", async () => {
    process.env.DEVTREE_TAILSCALE_HOST = "devbox.example.ts.net";
    const [plugin] = await devtree_vite_plugins(base_config);
    const next_config = run_config_hook(plugin, { server: { allowedHosts: ["app.local"] } });

    expect(next_config).toMatchObject({
      server: {
        allowedHosts: ["app.local", "devbox.example.ts.net"],
      },
    });
  });

  test("does not override allowedHosts when already fully open", async () => {
    process.env.DEVTREE_TAILSCALE_HOST = "devbox.example.ts.net";
    const [plugin] = await devtree_vite_plugins(base_config);
    const next_config = run_config_hook(plugin, { server: { allowedHosts: true } }) as {
      server?: { allowedHosts?: boolean };
    };

    expect(next_config?.server?.allowedHosts).toBe(true);
  });
});
