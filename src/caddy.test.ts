import { describe, expect, test } from "vite-plus/test";

import {
  CADDY_DEFAULT_ADMIN_URL,
  CADDY_SERVER_ID,
  type Caddy_fetch,
  create_caddy_config,
  create_caddy_route,
  get_caddy_route_id,
  get_caddy_listen_addresses,
  is_caddy_ready,
  register_caddy_route,
  remove_caddy_route,
} from "./caddy.ts";

describe("Caddy routing", () => {
  test("creates a private Devtree Caddy configuration", () => {
    const config = create_caddy_config(1355);

    expect(config.admin).toEqual({
      listen: "127.0.0.1:2020",
      config: {
        persist: false,
      },
    });
    expect(config.apps.http.servers.devtree).toEqual({
      "@id": CADDY_SERVER_ID,
      listen: ["127.0.0.1:1355"],
      automatic_https: {
        disable: true,
      },
      routes: [],
    });
  });

  test("creates an exact host route to a loopback Vite port", () => {
    const route = create_caddy_route({
      route_id: get_caddy_route_id("abc123"),
      hostname: "feature-123--web-ui.alice.dev.example.com",
      upstream_port: 5178,
    });

    expect(route).toEqual({
      "@id": "devtree-route-abc123",
      match: [
        {
          host: ["feature-123--web-ui.alice.dev.example.com"],
        },
      ],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [
            {
              dial: "127.0.0.1:5178",
            },
          ],
        },
      ],
      terminal: true,
    });
  });

  test("replaces only its own route before registering it", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetch_caddy: Caddy_fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    };
    const route = create_caddy_route({
      route_id: "devtree-route-abc123",
      hostname: "web-ui.alice.dev.example.com",
      upstream_port: 5178,
    });

    await register_caddy_route(CADDY_DEFAULT_ADMIN_URL, route, fetch_caddy);

    expect(calls.map(({ input, init }) => [init?.method, input])).toEqual([
      ["DELETE", "http://127.0.0.1:2020/id/devtree-route-abc123"],
      ["POST", "http://127.0.0.1:2020/id/devtree-server/routes"],
    ]);
    expect(new Headers(calls[0]?.init?.headers).get("origin")).toBe(
      "http://127.0.0.1:2020",
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(route);
  });

  test("removes a missing route without failing", async () => {
    const fetch_caddy: Caddy_fetch = async () =>
      new Response(null, { status: 404 });

    await expect(
      remove_caddy_route(CADDY_DEFAULT_ADMIN_URL, "devtree-route-missing", fetch_caddy),
    ).resolves.toBeUndefined();
  });

  test("distinguishes a running Caddy process without the Devtree server", async () => {
    const fetch_caddy: Caddy_fetch = async () =>
      new Response(null, { status: 404 });

    await expect(is_caddy_ready(CADDY_DEFAULT_ADMIN_URL, fetch_caddy)).resolves.toBe(false);
  });

  test("reads the public listener from the Devtree Caddy server", async () => {
    const fetch_caddy: Caddy_fetch = async () =>
      Response.json(["127.0.0.1:1355"]);

    await expect(
      get_caddy_listen_addresses(CADDY_DEFAULT_ADMIN_URL, fetch_caddy),
    ).resolves.toEqual(["127.0.0.1:1355"]);
  });

  test("reports an unreachable Caddy admin API actionably", async () => {
    const fetch_caddy: Caddy_fetch = async () => {
      throw new Error("connection refused");
    };

    await expect(is_caddy_ready(CADDY_DEFAULT_ADMIN_URL, fetch_caddy)).rejects.toThrow(
      "devtree doctor --fix",
    );
  });

  test("rejects public Caddy admin endpoints", () => {
    expect(() => create_caddy_config(1355, "http://example.com:2020")).toThrow(
      "must use a local host",
    );
  });
});
