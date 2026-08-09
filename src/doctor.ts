import type { Devtree_config } from "./config.ts";
import type { Devtree_instance } from "./instance.ts";

export function is_proxy_tailscale_mode(mode: string) {
  return mode === "proxy" || mode === "portless-proxy";
}

export function get_proxy_mode_configuration_error(
  config: Devtree_config,
  instance?: Pick<Devtree_instance, "routing_enabled">,
) {
  const inferred_mode =
    config.tailscale?.mode ??
    (config.tailscale?.enabled === true && config.routing?.provider?.kind === "caddy"
      ? "proxy"
      : "direct");
  const proxy_mode = is_proxy_tailscale_mode(inferred_mode);

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
    return 'Tailscale proxy routing needs an application hostname. Run `devtree setup --interactive`, configure base_domain and machine_name in .devtree.yml files, or provide routing.hostname.';
  }

  if (instance && !instance.routing_enabled) {
    return 'tailscale.mode "proxy" requires the configured routing provider to be enabled';
  }

  return null;
}
