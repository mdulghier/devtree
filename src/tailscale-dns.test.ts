import { describe, expect, test } from "vite-plus/test";

import { validate_tailscale_hostname } from "./tailscale-dns.ts";

describe("Tailscale hostname validation", () => {
  test("accepts wildcard DNS pointing to the tailnet address", async () => {
    await expect(
      validate_tailscale_hostname(
        "web-ui.alice.dev.example.com",
        "100.101.102.103",
        async () => ["100.101.102.103"],
      ),
    ).resolves.toBe("tailnet");
  });

  test("accepts the existing explicit local hosts-file workflow", async () => {
    await expect(
      validate_tailscale_hostname(
        "web-ui.alice.dev.example.com",
        "100.101.102.103",
        async () => ["127.0.0.1"],
      ),
    ).resolves.toBe("local-hosts");
  });

  test("rejects DNS pointing at the wrong address actionably", async () => {
    await expect(
      validate_tailscale_hostname(
        "web-ui.alice.dev.example.com",
        "100.101.102.103",
        async () => ["192.0.2.10"],
      ),
    ).rejects.toThrow("wildcard DNS record");
  });

  test("rejects an unresolvable hostname actionably", async () => {
    await expect(
      validate_tailscale_hostname(
        "web-ui.alice.dev.example.com",
        "100.101.102.103",
        async () => {
          throw new Error("ENOTFOUND");
        },
      ),
    ).rejects.toThrow("pnpm devtree hosts");
  });
});
