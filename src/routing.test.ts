import { describe, expect, test } from "vite-plus/test";

import type { Devtree_config } from "./config.ts";
import { CADDY_DEFAULT_ADMIN_URL } from "./caddy.ts";
import { resolve_routing } from "./routing.ts";

function create_config(): Devtree_config {
  return {
    app_name: "web-ui",
    env: {
      provider: "dotenv",
      entries: () => [],
    },
  };
}

describe("resolve_routing", () => {
  test("keeps Portless as the default provider", () => {
    expect(resolve_routing(create_config(), {})).toMatchObject({
      provider_kind: "portless",
      enabled: true,
      hostname_resolver: null,
      port: 1355,
      https: false,
      caddy_admin_url: null,
    });
  });

  test("keeps legacy Portless settings and environment overrides", () => {
    const config = create_config();

    config.portless = {
      hostname: ({ app_name }) => `${app_name}.alice.dev.example.com`,
      bootstrap: "manual",
    };

    expect(
      resolve_routing(config, {
        PORTLESS_PORT: "2468",
        PORTLESS_HTTPS: "1",
      }),
    ).toMatchObject({
      provider_kind: "portless",
      enabled: true,
      port: 2468,
      https: true,
      bootstrap: "manual",
    });
  });

  test("resolves the Caddy provider from the new routing configuration", () => {
    const config = create_config();
    const hostname = ({ app_name }: { app_name: string }) =>
      `${app_name}.alice.dev.example.com`;

    config.routing = {
      provider: {
        kind: "caddy",
      },
      hostname,
      port: 1355,
      https: false,
    };

    expect(resolve_routing(config, {})).toEqual({
      provider_kind: "caddy",
      enabled: true,
      hostname_resolver: hostname,
      port: 1355,
      https: false,
      bootstrap: "best-effort",
      caddy_admin_url: CADDY_DEFAULT_ADMIN_URL,
    });
  });

  test("does not let PORTLESS disable Caddy routing", () => {
    const config = create_config();

    config.routing = {
      provider: { kind: "caddy" },
      port: 1355,
      https: false,
    };

    expect(resolve_routing(config, { PORTLESS: "0" }).enabled).toBe(true);
  });

  test("does not apply legacy Portless URL settings to Caddy", () => {
    const config = create_config();

    config.portless = {
      port: 2468,
      https: true,
    };
    config.routing = {
      provider: { kind: "caddy" },
    };

    expect(
      resolve_routing(config, {
        PORTLESS_PORT: "3579",
        PORTLESS_HTTPS: "1",
      }),
    ).toMatchObject({
      port: 1355,
      https: false,
    });
  });

  test("rejects HTTPS until the Caddy provider supports it", () => {
    const config = create_config();

    config.routing = {
      provider: { kind: "caddy" },
      https: true,
    };

    expect(() => resolve_routing(config, {})).toThrow("plain HTTP only");
  });
});
