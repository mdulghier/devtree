# Devtree

Run the same Vite app in multiple git worktrees without local-dev collisions.

Devtree gives each worktree its own public URL, managed env block, scoped dependency names, setup hooks, and garbage collection for orphaned local resources.

## Use

### 1. Install

Devtree can launch either `vite-plus` or plain `vite`. It defaults to `vite-plus` for compatibility with existing projects.

Install Devtree itself:

```bash
pnpm add -D devtree
```

Dependencies you may also need:

- `vite-plus` or `vite` - required. Devtree runs `vp dev` by default, or `vite dev` when `dev_server.runner` is `"vite"`.
- `portless` - required unless you disable it with `portless.enabled: false` or `PORTLESS=0`. The `portless` command must be available on `PATH`.
- `tailscale` - optional, only needed when `tailscale.enabled` is `true`.
- `varlock` and `@varlock/vite-integration` - required only when `env.provider` is set to `"varlock"`.

Install `portless` in the repo so `devtree` can find it:

```bash
pnpm add -D portless
```

If you want `portless` available outside pnpm-managed scripts too, install it globally:

```bash
pnpm add -g portless
```

If you use `varlock`, install both pieces together:

```bash
pnpm add -D varlock @varlock/vite-integration
```

That gives you the `varlock` CLI plus the Vite integration Devtree expects.

### What These Tools Do

- [`portless`](https://github.com/vercel-labs/portless) gives each local app a stable named URL instead of a random port. Devtree uses it to give every worktree its own predictable public URL and to run the dev server behind that URL.
- [`varlock`](https://github.com/dmno-dev/varlock) is an env/schema tool for loading, validating, and injecting environment variables. Devtree uses it when `env.provider` is set to `"varlock"` so hooks and dev commands run with resolved, validated env values.

### 2. Add `devtree.config.ts`

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "my-app",
  dev_server: {
    runner: "vite-plus",
  },
  tailscale: {
    enabled: true,
  },
  env: {
    provider: "dotenv",
    entries: ({ instance }) => [
      {
        kind: "value",
        key: "APP_URL",
        value: instance.public_url,
      },
      {
        kind: "value",
        key: "DATABASE_PORT",
        value: String(instance.allocate_port("postgres", 5400)),
      },
    ],
  },
});
```

By default Devtree manages a block inside `.env.local`. Set `env.file_path` if you want a different file.

Set `dev_server.runner` to `"vite"` if the app uses plain Vite and should launch with `vite dev`.

If you enable `tailscale`, Devtree checks for the `tailscale` CLI, reads the machine's MagicDNS hostname, starts Vite on `0.0.0.0`, and adds that hostname to Vite's allowed hosts so the dev server can be reached over Tailscale.

This existing behavior is the legacy `direct` mode. For a shared Portless proxy exposed through Tailscale, use `portless-proxy` mode as described below; that mode keeps Vite on `127.0.0.1`.

### 3. Register the Vite plugin

Use your app's existing config helper. Plain Vite apps import from `vite`; VitePlus apps can keep importing from `vite-plus`.

```ts
import { defineConfig } from "vite";
import { devtree_vite_plugins } from "devtree/vite";

import devtree_config from "./devtree.config.ts";

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
});
```

### 4. Add a script

```json
{
  "scripts": {
    "devtree": "devtree"
  }
}
```

### 5. Run it

Run these from the repo root, or any subdirectory inside a repo that has `devtree.config.ts`.

```bash
pnpm devtree doctor --fix
pnpm devtree setup
pnpm devtree dev
pnpm devtree info
pnpm devtree gc --dry-run
```

- `doctor --fix` checks prerequisites, bootstraps `portless`, and validates Tailscale when `tailscale.enabled` is on
- `setup` resolves and validates the public hostname, writes env overrides, starts dependencies, and runs hooks
- `dev` starts the app through Devtree
- `info` prints the public URL and hostname, Tailscale mode, Portless state, and instance names
- `gc` removes orphaned dependency resources from deleted worktrees

Other commands:

- `devtree deps start|stop|logs`
- `devtree config tailscale.enabled true`
- `devtree env write|show`

`devtree config <key.path>` prints the current value from `devtree.config.ts`.

`devtree config <key.path> <value>` writes the new value back into `devtree.config.ts`.

Examples:

```bash
pnpm devtree config tailscale.enabled true
pnpm devtree config dev_server.runner vite
pnpm devtree config portless.https "inherit"
pnpm devtree config namespace personal-dev
pnpm devtree config tailscale.enabled
```

Add `dependencies` and `hooks` in `devtree.config.ts` when you want Compose services, custom setup steps, migrations, or pre-dev commands.

### Canonical Portless Hostnames

Use `portless.hostname` when one complete hostname must work both on the Devtree machine and from the tailnet. The callback receives the normalized logical app name and a collision-resistant worktree slug. The worktree slug is `null` in the primary checkout.

Keep developer-specific values in the machine environment, not in `devtree.config.ts`:

```bash
export DEVTREE_DEVELOPER_NAMESPACE=developer
export DEVTREE_PUBLIC_DOMAIN=dev.example.com
```

A complete consumer configuration is:

```ts
import { define_devtree_config } from "devtree";

function read_required_env(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required for the canonical Devtree hostname`);
  }

  return value;
}

export default define_devtree_config({
  app_name: "web-ui",
  portless: {
    hostname: ({ app_name, worktree_slug }) => {
      const developer_namespace = read_required_env("DEVTREE_DEVELOPER_NAMESPACE");
      const public_domain = read_required_env("DEVTREE_PUBLIC_DOMAIN");
      const route_name = worktree_slug ? `${worktree_slug}--${app_name}` : app_name;

      return `${route_name}.${developer_namespace}.${public_domain}`;
    },
    port: 1355,
    https: false,
  },
  tailscale: {
    enabled: true,
    mode: "portless-proxy",
  },
  env: {
    provider: "dotenv",
    entries: ({ instance }) => [
      {
        kind: "value",
        key: "APP_URL",
        value: instance.public_url,
      },
    ],
  },
});
```

This produces URLs such as:

```text
http://web-ui.developer.dev.example.com:1355
http://feature-123--web-ui.developer.dev.example.com:1355
```

Devtree lowercases and validates the complete hostname. DNS labels must use letters, digits, and interior hyphens, each label must be at most 63 characters, and the hostname must be at most 253 characters. Branch names that need normalization or truncation receive a stable short hash so distinct source names do not silently collapse onto the same route. A detached checkout falls back to its worktree identity.

`instance.public_hostname` and `instance.public_url` expose the resolved values. Managed child processes receive `DEVTREE_PUBLIC_HOSTNAME`, `DEVTREE_PUBLIC_URL`, and `DEVTREE_TAILSCALE_MODE`. In `portless-proxy` mode, `DEVTREE_TAILSCALE_HOST` is intentionally unset because the machine's MagicDNS name is not the application hostname.

Without `portless.hostname`, behavior is unchanged:

```text
http://<app>.localhost:1355
http://<worktree>.<app>.localhost:1355
```

#### Portless Exact-Hostname Contract

Canonical routing requires this Portless CLI contract:

```text
portless run --force --hostname <complete-hostname> -- <command>
```

`--hostname` must register the supplied hostname exactly and must not add Portless's own worktree prefix. Devtree deliberately checks `portless run --help` for this contract before setup or development. Portless 0.15.5 does not yet expose the flag, so canonical mode reports an actionable compatibility error instead of silently registering a different hostname. No `node_modules` patch or alias-route workaround is used.

### Tailscale Modes

- `tailscale: { enabled: true }` remains source- and runtime-compatible and means legacy direct mode.
- `tailscale: { enabled: true, mode: "direct" }` explicitly selects the same behavior: Devtree binds Vite to `0.0.0.0` and allowlists the machine's MagicDNS host.
- `tailscale: { enabled: true, mode: "portless-proxy" }` keeps Vite on `127.0.0.1`, uses the canonical Portless hostname, and expects Portless to own the single shared Tailscale TCP forwarding endpoint.
- Install the `tailscale` CLI and make sure you're logged in on the machine running `devtree dev`.
- In proxy mode, `devtree doctor` checks the hostname callback, exact-hostname Portless compatibility, Tailscale connectivity, DNS resolution, and loopback-only Vite binding.
- DNS records, Tailscale policy, and the shared TCP forward are infrastructure responsibilities. Devtree diagnoses them but never modifies DNS, `/etc/hosts`, or tailnet administration.

To migrate from direct exposure, first provision DNS and the one shared Tailscale-to-Portless TCP forward outside Devtree. Then add `portless.hostname`, set `portless.port`, and select `portless-proxy`. Run `pnpm devtree doctor` before `setup`; do not remove the direct-mode configuration until the Portless exact-hostname contract is available on every developer machine.

If you use an AI agent, run `npx @tanstack/intent@latest install`.
