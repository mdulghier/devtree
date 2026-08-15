import { describe, expect, test } from "vite-plus/test";

import type { Devtree_config, Routing_hostname_context } from "./config.ts";
import {
  create_identity_slug,
  format_public_url,
  join_identity_slugs,
  resolve_configured_public_hostname,
  resolve_default_public_hostname,
  resolve_portless_https,
  resolve_portless_port,
  validate_public_hostname,
} from "./hostname.ts";

function create_context(
  overrides: Partial<Routing_hostname_context> = {},
): Routing_hostname_context {
  return {
    project_name: "acme-cloud",
    session_name: "default",
    endpoint_name: "ui",
    is_primary_endpoint: true,
    is_default_session: true,
    ...overrides,
  };
}

function create_config(hostname?: (context: Routing_hostname_context) => string): Devtree_config {
  return {
    project_name: "acme-cloud",
    portless: hostname ? { hostname } : undefined,
    env: {
      provider: "dotenv",
      entries: () => [],
    },
  };
}

describe("endpoint hostnames", () => {
  test("uses the short project hostname for the default primary endpoint", () => {
    expect(resolve_default_public_hostname(create_context(), {})).toBe("acme-cloud.localhost");
  });

  test("includes session and secondary endpoint names", () => {
    expect(
      resolve_default_public_hostname(
        create_context({
          session_name: "billing-redesign",
          endpoint_name: "api",
          is_primary_endpoint: false,
          is_default_session: false,
        }),
        {},
      ),
    ).toBe("billing-redesign.api.acme-cloud.localhost");
  });

  test("resolves a configured complete hostname", () => {
    const config = create_config(
      ({ project_name, session_name, endpoint_name }) =>
        `${session_name}-${endpoint_name}.${project_name}.example.com`,
    );

    expect(
      resolve_configured_public_hostname(
        config,
        create_context({ session_name: "billing", is_default_session: false }),
      ),
    ).toBe("billing-ui.acme-cloud.example.com");
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
    expect(format_public_url("acme-cloud.example.com", true, 2468)).toBe(
      "https://acme-cloud.example.com:2468",
    );
  });

  test("rejects invalid and excessively long hostnames", () => {
    expect(() => validate_public_hostname("bad_host.example.com")).toThrow(
      "must contain only lowercase letters",
    );
    expect(() => validate_public_hostname(`${"a".repeat(64)}.example.com`)).toThrow(
      "63-character DNS label limit",
    );
  });

  test("makes normalized and long identities collision-resistant", () => {
    const slash_slug = create_identity_slug("Feature/Foo", "one");
    const punctuation_slug = create_identity_slug("feature_foo", "two");
    const long_slug = create_identity_slug("a".repeat(100), "three");

    expect(slash_slug).not.toBe(punctuation_slug);
    expect(slash_slug).toMatch(/^feature-foo-[a-f0-9]{8}$/u);
    expect(long_slug.length).toBeLessThanOrEqual(63);
  });

  test("keeps flattened Caddy route labels within the DNS limit", () => {
    const label = join_identity_slugs([
      "feature-with-a-very-descriptive-name",
      "internal-administration-api",
      "enterprise-operations-cloud",
    ]);

    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/-[a-f0-9]{8}$/u);
  });
});
