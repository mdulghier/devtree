import type { Devtree_instance } from "./instance.ts";
import type { Resolved_tailscale } from "./tailscale.ts";

export function create_runtime_env(
  instance: Devtree_instance,
  effective_env_values: Record<string, string>,
  tailscale: Resolved_tailscale,
  env_overrides?: Record<string, string | undefined>,
) {
  return {
    ...effective_env_values,
    ...env_overrides,
    DEVTREE_ACTIVE: "1",
    DEVTREE_APP_NAME: instance.app_name,
    DEVTREE_INSTANCE_ID: instance.instance_id,
    DEVTREE_NAMESPACE: instance.registry_namespace,
    DEVTREE_PUBLIC_HOSTNAME: instance.public_hostname,
    DEVTREE_PUBLIC_URL: instance.public_url,
    DEVTREE_TAILSCALE_ENABLED: tailscale.enabled ? "1" : "0",
    DEVTREE_TAILSCALE_MODE: tailscale.mode,
    DEVTREE_TAILSCALE_HOST:
      tailscale.mode === "direct" ? (tailscale.host ?? undefined) : undefined,
    DEVTREE_WORKTREE_PATH: instance.worktree_path,
    DEVTREE_LABEL_PREFIX: instance.label_prefix,
  };
}
