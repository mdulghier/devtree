import type { Plugin, UserConfig } from "vite";

import type { Devtree_config } from "./config.ts";

function create_core_devtree_plugin(): Plugin {
  return {
    name: "devtree",
    apply: "serve",
    config(user_config) {
      const next_config: UserConfig = {};
      const public_hostname = process.env.DEVTREE_PUBLIC_HOSTNAME?.trim();
      const tailscale_host =
        process.env.DEVTREE_TAILSCALE_MODE === "proxy" ||
        process.env.DEVTREE_TAILSCALE_MODE === "portless-proxy"
          ? undefined
          : process.env.DEVTREE_TAILSCALE_HOST?.trim();

      if (!user_config.server?.host) {
        next_config.server = {
          ...user_config.server,
          host: "127.0.0.1",
        };
      }

      const devtree_allowed_hosts = [public_hostname, tailscale_host].filter(
        (hostname): hostname is string => Boolean(hostname),
      );

      if (devtree_allowed_hosts.length > 0 && user_config.server?.allowedHosts !== true) {
        const allowed_hosts = user_config.server?.allowedHosts ?? [];
        const next_allowed_hosts = [...allowed_hosts];

        for (const hostname of devtree_allowed_hosts) {
          if (!next_allowed_hosts.includes(hostname)) {
            next_allowed_hosts.push(hostname);
          }
        }

        next_config.server = {
          ...next_config.server,
          ...user_config.server,
          allowedHosts: next_allowed_hosts,
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

      console.warn("[devtree] Run `pnpm devtree dev` for isolated multi-instance development.");
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
