# Devtree

Run the same Vite+ app in multiple git worktrees without local-dev collisions.

Devtree gives each worktree its own public URL, managed env block, scoped dependency names, setup hooks, and garbage collection for orphaned local resources.

## Use

### 1. Install

Devtree assumes your app already uses `vite-plus`. It is a required peer dependency, but this README does not install it for you.

Install Devtree itself:

```bash
vp add -D devtree
```

Dependencies you may also need:

- `vite-plus` - required. Your app should already have it installed and be using it.
- `portless` - required unless you disable it with `portless.enabled: false` or `PORTLESS=0`. The `portless` command must be available on `PATH`.
- `varlock` and `@varlock/vite-integration` - required only when `env.provider` is set to `"varlock"`.

Install `portless` in the repo so `vp devtree ...` can find it:

```bash
vp add -D portless
```

If you want `portless` available outside pnpm-managed scripts too, install it globally:

```bash
vp add -g portless
```

If you use `varlock`, install both pieces together:

```bash
vp add -D varlock @varlock/vite-integration
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

### 3. Register the Vite plugin

```ts
import { defineConfig } from "vite-plus";
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

- `doctor --fix` checks prerequisites and bootstraps `portless`
- `setup` writes env overrides, starts dependencies, and runs hooks
- `dev` starts the app through Devtree
- `info` prints the current instance URL and names
- `gc` removes orphaned dependency resources from deleted worktrees

Other commands:

- `devtree deps start|stop|logs`
- `devtree env write|show`

Add `dependencies` and `hooks` in `devtree.config.ts` when you want Compose services, custom setup steps, migrations, or pre-dev commands.

If you use an AI agent, run `npx @tanstack/intent@latest install`.
