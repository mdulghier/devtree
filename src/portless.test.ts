import { describe, expect, test } from "vite-plus/test";

import { get_portless_alias_add_args, get_portless_alias_remove_args } from "./portless.ts";

describe("Portless endpoint aliases", () => {
  test("registers a complete hostname for a fixed target port", () => {
    expect(get_portless_alias_add_args("feature.api.project.localhost", 5317)).toEqual([
      "alias",
      "feature.api.project.localhost",
      "5317",
      "--force",
    ]);
  });

  test("removes only the named alias", () => {
    expect(get_portless_alias_remove_args("feature.api.project.localhost")).toEqual([
      "alias",
      "--remove",
      "feature.api.project.localhost",
    ]);
  });
});
