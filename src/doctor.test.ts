import { describe, expect, test } from "vite-plus/test";

import type { Devtree_config } from "./config.ts";
import {
  get_proxy_mode_configuration_error,
  is_proxy_tailscale_mode,
} from "./doctor.ts";

function create_config(): Devtree_config {
  return {
    app_name: "demo-app",
    routing: {
      provider: { kind: "caddy" },
      hostname: ({ app_name }) => `${app_name}.alice.devtree.test`,
    },
    tailscale: {
      enabled: true,
      mode: "proxy",
    },
    env: {
      provider: "dotenv",
      entries: () => [],
    },
  };
}

describe("proxy mode doctor configuration", () => {
  test("accepts Caddy routing without requiring Portless", () => {
    expect(
      get_proxy_mode_configuration_error(create_config(), { routing_enabled: true }),
    ).toBeNull();
  });

  test("accepts proxy mode and keeps the old Portless name as an alias", () => {
    expect(is_proxy_tailscale_mode("proxy")).toBe(true);
    expect(is_proxy_tailscale_mode("portless-proxy")).toBe(true);
  });

  test("requires Tailscale to be enabled", () => {
    const config = create_config();
    config.tailscale = { enabled: false, mode: "proxy" };

    expect(get_proxy_mode_configuration_error(config)).toContain(
      "tailscale.enabled is not true",
    );
  });

  test("rejects explicitly configured direct exposure with Caddy routing", () => {
    const config = create_config();
    config.tailscale = { enabled: true, mode: "direct" };

    expect(get_proxy_mode_configuration_error(config)).toContain(
      'tailscale.mode to be "proxy"',
    );
  });

  test("requires a complete hostname resolver", () => {
    const config = create_config();
    delete config.routing?.hostname;

    expect(get_proxy_mode_configuration_error(config)).toContain("routing.hostname");
  });

  test("requires the selected routing provider to be enabled", () => {
    expect(
      get_proxy_mode_configuration_error(create_config(), { routing_enabled: false }),
    ).toContain("routing provider to be enabled");
  });
});
