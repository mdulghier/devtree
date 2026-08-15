import { describe, expect, test } from "vite-plus/test";

import type { Loaded_devtree_config } from "./config.ts";
import { create_devtree_instance } from "./instance.ts";
import { create_runtime_env } from "./runtime-env.ts";
import type { Resolved_tailscale } from "./tailscale.ts";

function create_instance() {
  const loaded_config: Loaded_devtree_config = {
    config: {
      project_name: "web-ui",
      portless: {
        hostname: ({ project_name }) => `${project_name}.developer.dev.example.com`,
      },
      env: {
        provider: "dotenv",
        entries: () => [],
      },
    },
    config_path: "/tmp/web-ui/devtree.config.ts",
    repo_root: "/tmp/web-ui",
  };

  return create_devtree_instance(loaded_config);
}

function create_tailscale(mode: Resolved_tailscale["mode"]): Resolved_tailscale {
  return {
    enabled: mode !== "disabled",
    mode,
    cli_available: mode !== "disabled",
    connected: mode !== "disabled",
    host: mode === "disabled" ? null : "devbox.example.ts.net",
    ipv4: mode === "disabled" ? null : "100.101.102.103",
    node_id: mode === "disabled" ? null : "node-123",
    error: null,
  };
}

describe("create_runtime_env", () => {
  test("injects the canonical public hostname, URL, and proxy mode", () => {
    const instance = create_instance();
    const runtime_env = create_runtime_env(instance, {}, create_tailscale("proxy"));

    expect(runtime_env.DEVTREE_PUBLIC_HOSTNAME).toBe("web-ui.developer.dev.example.com");
    expect(runtime_env.DEVTREE_PUBLIC_URL).toBe("http://web-ui.developer.dev.example.com:1355");
    expect(runtime_env.DEVTREE_PROJECT_NAME).toBe("web-ui");
    expect(runtime_env.DEVTREE_SESSION_NAME).toBe("default");
    expect(runtime_env.DEVTREE_DEPENDENCY_OWNER).toBe("default");
    expect(runtime_env.DEVTREE_ROUTING_PROVIDER).toBe("portless");
    expect(runtime_env.DEVTREE_TAILSCALE_MODE).toBe("proxy");
    expect(runtime_env.DEVTREE_TAILSCALE_HOST).toBeUndefined();
  });

  test("retains the MagicDNS host in legacy direct mode", () => {
    const runtime_env = create_runtime_env(create_instance(), {}, create_tailscale("direct"));

    expect(runtime_env.DEVTREE_TAILSCALE_HOST).toBe("devbox.example.ts.net");
  });

  test("injects the persisted Tailscale application URL", () => {
    const runtime_env = create_runtime_env(
      create_instance(),
      {},
      create_tailscale("proxy"),
      undefined,
      {
        local_url: "http://web-ui.developer.dev.example.com:1355",
        local_hostname: "web-ui.developer.dev.example.com",
        tailscale_url: "http://web-ui.developer.dev.example.com:2468",
        tailscale_hostname: "web-ui.developer.dev.example.com",
        tailscale_port: 2468,
        tailscale_ipv4: "100.101.102.103",
        mapping_key: "node-123:2468",
        mapping_target: "localhost:1355",
        mapping_owned: true,
      },
    );

    expect(runtime_env.DEVTREE_TAILSCALE_URL).toBe("http://web-ui.developer.dev.example.com:2468");
    expect(runtime_env.DEVTREE_TAILSCALE_APPLICATION_PORT).toBe("2468");
  });
});
