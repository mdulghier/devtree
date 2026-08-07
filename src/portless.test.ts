import { describe, expect, test } from "vite-plus/test";

import {
  get_portless_compatibility_error,
  portless_supports_exact_hostname,
} from "./portless.ts";

describe("Portless compatibility", () => {
  test("accepts a CLI with the exact-hostname contract", () => {
    const help_text = "portless run --hostname <hostname> [command...]";

    expect(portless_supports_exact_hostname(help_text)).toBe(true);
    expect(get_portless_compatibility_error(help_text)).toBeNull();
  });

  test("reports an actionable error for the current legacy CLI contract", () => {
    const help_text = "portless run --name <name> [command...]";

    expect(portless_supports_exact_hostname(help_text)).toBe(false);
    expect(get_portless_compatibility_error(help_text)).toContain(
      "without adding a worktree prefix",
    );
  });
});
