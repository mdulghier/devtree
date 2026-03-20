# Devtree

Devtree is a worktree-aware multi-instance development toolkit for Vite+ apps.

It handles the annoying local-dev glue that usually gets copy-pasted badly across repos:

- stable `portless` URLs per worktree
- managed local env overrides per instance
- dependency lifecycle orchestration
- migration and setup hooks
- garbage collection for deleted worktrees
- optional `varlock` integration from day one

## Package Surface

- `devtree` CLI
- `devtree/vite` Vite plugin helper
- `devtree.config.ts` typed repo config

## Quick Start

Install the package and add a repo-level `devtree.config.ts`.

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "my-app",
  env: {
    provider: "dotenv",
    entries: () => [],
  },
});
```

Register the Vite integration:

```ts
import { defineConfig } from "vite-plus";
import { devtree_vite_plugins } from "devtree/vite";

import devtree_config from "./devtree.config.ts";

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
});
```

Add a repo script:

```json
{
  "scripts": {
    "devtree": "devtree"
  }
}
```

Then use the CLI:

```bash
vp run devtree doctor --fix
vp run devtree setup
vp run devtree dev
vp run devtree gc -- --dry-run
```

## Package Development

From `packages/devtree/`:

```bash
vp install
vp run build
vp run check
vp run test
```

## Commands

- `devtree doctor [--fix]`
- `devtree info`
- `devtree setup`
- `devtree dev [-- <vite args>]`
- `devtree deps start|stop|logs`
- `devtree gc [--dry-run] [--verbose]`
- `devtree env write|show`

## Config Overview

`devtree.config.ts` owns:

- app identity and namespace
- `portless` policy
- env provider: `dotenv` or `varlock`
- managed env entries
- dependency adapters
- lifecycle hooks
- garbage collection labels and registry namespace

## Varlock

Set `env.provider` to `"varlock"` to enable schema-driven env validation.

In varlock mode Devtree:

- still writes managed instance values to the configured local env override file
- runs hooks through `varlock run`
- wraps `vp dev` as `varlock run -- portless run --force --name <app_name> vp dev ...`
- expects `varlock` and `@varlock/vite-integration` to be installed in the consuming repo

## Docker Garbage Collection

Devtree records managed dependency projects and labels Docker resources so `devtree gc` can remove leftovers after a worktree is deleted.

That means less archaeology in Docker Desktop. A rare local-dev miracle.
