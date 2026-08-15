import { describe, expect, test } from "vite-plus/test";

import { format_config_value, get_config_value, update_config_text } from "./config-command.ts";
import type { Devtree_config } from "./config.ts";

const config_file_text = `import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "demo-app",
  tailscale: {
    enabled: false,
  },
  env: {
    provider: "dotenv",
    entries: () => [],
  },
});
`;

describe("update_config_text", () => {
  test("updates an existing nested boolean value", () => {
    expect(update_config_text(config_file_text, "tailscale.enabled", "true")).toContain(
      "enabled: true",
    );
  });

  test("creates missing nested config objects", () => {
    expect(update_config_text(config_file_text, "portless.https", '"inherit"')).toContain(
      'portless: {\n        https: "inherit"\n    }',
    );
  });

  test("treats unparseable values as strings", () => {
    expect(update_config_text(config_file_text, "namespace", "personal dev")).toContain(
      'namespace: "personal dev"',
    );
  });

  test("creates the dev server runner config", () => {
    expect(update_config_text(config_file_text, "dev_server.runner", "vite")).toContain(
      'dev_server: {\n        runner: "vite"\n    }',
    );
  });
});

describe("get_config_value", () => {
  const config: Devtree_config = {
    project_name: "demo-app",
    tailscale: {
      enabled: true,
    },
    dev_server: {
      runner: "vite",
    },
    env: {
      provider: "dotenv",
      entries: () => [],
    },
  };

  test("reads nested values", () => {
    expect(get_config_value(config, "tailscale.enabled")).toBe(true);
  });

  test("returns undefined when a key is missing", () => {
    expect(get_config_value(config, "portless.enabled")).toBeUndefined();
  });

  test("reads the dev server runner", () => {
    expect(get_config_value(config, "dev_server.runner")).toBe("vite");
  });
});

describe("format_config_value", () => {
  test("prints strings with quotes", () => {
    expect(format_config_value("dotenv")).toBe('"dotenv"');
  });
});
