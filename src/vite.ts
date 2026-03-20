import type { Plugin, UserConfig } from "vite-plus";

import type { Devtree_config } from "./config.ts";

function create_core_devtree_plugin(): Plugin {
  return {
    name: "devtree",
    apply: "serve",
    config(user_config) {
      const next_config: UserConfig = {};

      if (!user_config.server?.host) {
        next_config.server = {
          ...user_config.server,
          host: "127.0.0.1",
        };
      }

      if (user_config.clearScreen === undefined) {
        next_config.clearScreen = false;
      }

      return next_config;
    },
    configResolved(resolved_config) {
      if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
        return;
      }

      if (resolved_config.command !== "serve") {
        return;
      }

      if (process.env.DEVTREE_ACTIVE === "1") {
        console.log(`[devtree] URL ${process.env.DEVTREE_PUBLIC_URL ?? "unknown"}`);
        console.log(`[devtree] Instance ${process.env.DEVTREE_INSTANCE_ID ?? "unknown"}`);
        return;
      }

      console.warn("[devtree] Run `vp run devtree dev` for isolated multi-instance development.");
    },
  };
}

export async function devtree_vite_plugins(config: Devtree_config) {
  const plugins: Plugin[] = [create_core_devtree_plugin()];

  if (config.env.provider !== "varlock") {
    return plugins;
  }

  const package_name = "@varlock/vite-integration";

  try {
    const imported_module = (await import(package_name)) as {
      varlockVitePlugin?: (options?: Record<string, unknown>) => Plugin;
    };

    if (!imported_module.varlockVitePlugin) {
      throw new Error(`Expected varlockVitePlugin export from ${package_name}.`);
    }

    plugins.unshift(imported_module.varlockVitePlugin({ ssrInjectMode: "init-only" }));
    return plugins;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Varlock mode is enabled, but ${package_name} could not be loaded. ${message}`);
  }
}
