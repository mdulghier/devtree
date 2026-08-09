import type { Devtree_instance } from "./instance.ts";
import type { Active_tailscale_routing } from "./routing-state.ts";
import type { Resolved_tailscale_mode } from "./tailscale.ts";

export function format_routing_info_lines(options: {
  instance: Devtree_instance;
  tailscale_mode: Resolved_tailscale_mode;
  active_tailscale_routing: Active_tailscale_routing | null;
  configured_tailscale_port: number;
}) {
  const lines = [
    `Public URL: ${options.instance.public_url}`,
    `Local URL: ${options.instance.public_url}`,
    `Public hostname: ${options.instance.public_hostname}`,
  ];

  if (options.tailscale_mode !== "proxy") {
    return lines;
  }

  const active_routing = options.active_tailscale_routing;

  lines.push(
    `Tailscale application URL: ${active_routing?.tailscale_url ?? "not configured; run `pnpm devtree doctor --fix`"}`,
    `Tailscale application hostname: ${active_routing?.tailscale_hostname ?? options.instance.public_hostname}`,
    `Tailscale application port: ${active_routing?.tailscale_port ?? options.configured_tailscale_port}`,
  );

  if (active_routing) {
    lines.push(
      `Tailscale Serve mapping: tcp:${active_routing.tailscale_port} -> ${active_routing.mapping_target}`,
      `Tailscale mapping ownership: ${active_routing.mapping_owned ? "Devtree" : "external (shared, not removable by Devtree)"}`,
    );
  }

  return lines;
}
