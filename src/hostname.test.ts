import { afterEach, describe, expect, test } from "vite-plus/test";

import type { Devtree_config, Portless_hostname_context } from "./config.ts";
import {
  create_portless_worktree_slug,
  format_public_url,
  resolve_configured_public_hostname,
  resolve_legacy_public_hostname,
  resolve_portless_https,
  resolve_portless_port,
  validate_public_hostname,
} from "./hostname.ts";

function create_config(
  hostname?: (context: Portless_hostname_context) => string,
): Devtree_config {
  return {
    app_name: "web-ui",
    portless: hostname ? { hostname } : undefined,
    env: {
      provider: "dotenv",
      entries: () => [],
    },
  };
}

afterEach(() => {
  delete process.env.DEVTREE_DEVELOPER_NAMESPACE;
  delete process.env.DEVTREE_PUBLIC_DOMAIN;
});

describe("Portless hostnames", () => {
  test("keeps the legacy main-checkout .localhost hostname", () => {
    expect(resolve_legacy_public_hostname("web-ui", null, {})).toBe("web-ui.localhost");
  });

  test("keeps the legacy worktree .localhost hostname", () => {
    expect(resolve_legacy_public_hostname("web-ui", "feature-123", {})).toBe(
      "feature-123.web-ui.localhost",
    );
  });

  test("resolves a canonical main-checkout hostname", () => {
    const config = create_config(
      ({ app_name }) => `${app_name}.developer.dev.example.com`,
    );

    expect(
      resolve_configured_public_hostname(config, {
        app_name: "web-ui",
        worktree_slug: null,
      }),
    ).toBe("web-ui.developer.dev.example.com");
  });

  test("resolves a canonical flattened worktree hostname", () => {
    const config = create_config(({ app_name, worktree_slug }) => {
      const route_name = worktree_slug ? `${worktree_slug}--${app_name}` : app_name;

      return `${route_name}.developer.dev.example.com`;
    });

    expect(
      resolve_configured_public_hostname(config, {
        app_name: "web-ui",
        worktree_slug: "feature-123",
      }),
    ).toBe("feature-123--web-ui.developer.dev.example.com");
  });

  test("formats protocol and proxy-port configuration", () => {
    const config: Devtree_config = {
      ...create_config(),
      portless: {
        https: true,
        port: 2468,
      },
    };

    expect(resolve_portless_https(config, {})).toBe(true);
    expect(resolve_portless_port(config, {})).toBe(2468);
    expect(format_public_url("web-ui.example.com", true, 2468)).toBe(
      "https://web-ui.example.com:2468",
    );
  });

  test("inherits legacy protocol and port environment variables", () => {
    const config = create_config();

    expect(resolve_portless_https(config, { PORTLESS_HTTPS: "1" })).toBe(true);
    expect(resolve_portless_port(config, { PORTLESS_PORT: "1356" })).toBe(1356);
  });

  test.each(["DEVTREE_DEVELOPER_NAMESPACE", "DEVTREE_PUBLIC_DOMAIN"])(
    "reports a missing %s value actionably",
    (missing_name) => {
      process.env.DEVTREE_DEVELOPER_NAMESPACE = "developer";
      process.env.DEVTREE_PUBLIC_DOMAIN = "dev.example.com";
      delete process.env[missing_name];

      const config = create_config(({ app_name }) => {
        const developer_namespace = process.env.DEVTREE_DEVELOPER_NAMESPACE?.trim();
        const public_domain = process.env.DEVTREE_PUBLIC_DOMAIN?.trim();

        if (!developer_namespace) {
          throw new Error("DEVTREE_DEVELOPER_NAMESPACE is required");
        }

        if (!public_domain) {
          throw new Error("DEVTREE_PUBLIC_DOMAIN is required");
        }

        return `${app_name}.${developer_namespace}.${public_domain}`;
      });

      expect(() =>
        resolve_configured_public_hostname(config, {
          app_name: "web-ui",
          worktree_slug: null,
        }),
      ).toThrow(missing_name);
    },
  );

  test("rejects invalid and excessively long hostnames", () => {
    expect(() => validate_public_hostname("bad_host.example.com")).toThrow(
      "must contain only lowercase letters",
    );
    expect(() => validate_public_hostname(`${"a".repeat(64)}.example.com`)).toThrow(
      "63-character DNS label limit",
    );
    expect(() =>
      validate_public_hostname(
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      ),
    ).toThrow("253-character DNS hostname limit");
  });

  test("makes normalized and long worktree identities collision-resistant", () => {
    const slash_slug = create_portless_worktree_slug("Feature/Foo", "web-ui", "one");
    const punctuation_slug = create_portless_worktree_slug("feature_foo", "web-ui", "two");
    const long_slug = create_portless_worktree_slug("a".repeat(100), "web-ui", "three");

    expect(slash_slug).not.toBe(punctuation_slug);
    expect(slash_slug).toMatch(/^feature-foo-[a-f0-9]{8}$/u);
    expect(long_slug.length + "--web-ui".length).toBeLessThanOrEqual(63);
  });

  test("uses a deterministic fallback for an empty worktree identity", () => {
    expect(create_portless_worktree_slug(null, "web-ui", "abc123")).toBe(
      "worktree-abc123",
    );
  });
});
