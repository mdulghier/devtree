import { describe, expect, test } from "vite-plus/test";

import type { Devtree_config } from "./config.ts";
import {
  get_tailscale_mode,
  parse_tailscale_connection,
  parse_tailscale_host,
} from "./tailscale.ts";

describe("parse_tailscale_host", () => {
  test("reads the MagicDNS host from tailscale status output", () => {
    expect(
      parse_tailscale_host(JSON.stringify({ Self: { DNSName: "devbox.example.ts.net." } })),
    ).toBe("devbox.example.ts.net");
  });

  test("returns null when the host is missing", () => {
    expect(parse_tailscale_host(JSON.stringify({ Self: {} }))).toBeNull();
  });

  test("detects a connected Tailscale backend without requiring MagicDNS", () => {
    expect(
      parse_tailscale_connection(JSON.stringify({ BackendState: "Running", Self: {} })),
    ).toBe(true);
  });

  test("keeps enabled configurations in legacy direct mode by default", () => {
    const config: Devtree_config = {
      app_name: "demo",
      tailscale: { enabled: true },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("direct");
  });

  test("resolves the explicit Portless proxy mode", () => {
    const config: Devtree_config = {
      app_name: "demo",
      tailscale: { enabled: true, mode: "portless-proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("proxy");
  });

  test("resolves the provider-neutral proxy mode", () => {
    const config: Devtree_config = {
      app_name: "demo",
      tailscale: { enabled: true, mode: "proxy" },
      env: { provider: "dotenv", entries: () => [] },
    };

    expect(get_tailscale_mode(config)).toBe("proxy");
  });
});
