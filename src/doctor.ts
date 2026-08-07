import type { Devtree_config } from "./config.ts";
import type { Devtree_instance } from "./instance.ts";

export function is_proxy_tailscale_mode(mode: string) {
  return mode === "proxy" || mode === "portless-proxy";
}

export function get_proxy_mode_configuration_error(
  config: Devtree_config,
  instance?: Pick<Devtree_instance, "routing_enabled">,
) {
  const proxy_mode = is_proxy_tailscale_mode(config.tailscale?.mode ?? "direct");

  if (
    config.routing?.provider?.kind === "caddy" &&
    config.tailscale?.enabled === true &&
    !proxy_mode
  ) {
    return 'Caddy routing with Tailscale requires tailscale.mode to be "proxy"';
  }

  if (!proxy_mode) {
    return null;
  }

  if (config.tailscale?.enabled !== true) {
    return 'tailscale.mode is "proxy", but tailscale.enabled is not true';
  }

  if (!config.routing?.hostname && !config.portless?.hostname) {
    return 'tailscale.mode "proxy" requires routing.hostname to resolve a public hostname';
  }

  if (instance && !instance.routing_enabled) {
    return 'tailscale.mode "proxy" requires the configured routing provider to be enabled';
  }

  return null;
}
