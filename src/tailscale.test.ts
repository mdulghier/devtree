import { describe, expect, test } from "vite-plus/test";

import { parse_tailscale_host } from "./tailscale.ts";

describe("parse_tailscale_host", () => {
  test("reads the MagicDNS host from tailscale status output", () => {
    expect(
      parse_tailscale_host(JSON.stringify({ Self: { DNSName: "devbox.example.ts.net." } })),
    ).toBe("devbox.example.ts.net");
  });

  test("returns null when the host is missing", () => {
    expect(parse_tailscale_host(JSON.stringify({ Self: {} }))).toBeNull();
  });
});
