---
name: devtree-run-and-operate-devtree
description: >
  Run and troubleshoot daily devtree workflows: `doctor`, `setup`, `dev`,
  `info`, `env write`, `env show`, `deps start|stop|logs`, and `gc`. Load
  this when an agent needs to verify that the app is running, reachable at
  the worktree URL, and cleaned up correctly after worktrees are deleted.
type: core
library: devtree
library_version: "0.1.0"
sources:
  - "mdulghier/devtree:README.md"
  - "mdulghier/devtree:src/cli.ts"
  - "mdulghier/devtree:src/command-builder.ts"
  - "mdulghier/devtree:src/gc.ts"
  - "mdulghier/devtree:src/registry.ts"
  - "mdulghier/devtree:src/process.ts"
  - "mdulghier/devtree:src/instance.ts"
---

# Devtree - Run And Operate

## Setup

Use the CLI in this order when bringing up a worktree instance.

```bash
pnpm devtree doctor --fix
pnpm devtree setup
pnpm devtree dev
```

Then inspect the assigned URL and names.

```bash
pnpm devtree info
```

For cleanup and dependency inspection:

```bash
pnpm devtree deps logs
pnpm devtree gc --dry-run
```

## Core Patterns

### Verify health with doctor first

```bash
pnpm devtree doctor --fix
```

Use `doctor` as the first check; it validates local prerequisites and bootstraps `portless` when needed.

### Bring up dependencies before the dev server

```bash
pnpm devtree setup
pnpm devtree dev
```

`setup` writes env overrides, starts configured dependencies, and runs setup hooks before `dev` starts the app.

### Inspect the current instance URL and names

```bash
pnpm devtree info
```

`info` prints the public URL, app name, instance ID, scoped name, worktree path, env provider, env file, and Compose project names.

### Clean up orphaned Docker resources safely

```bash
pnpm devtree gc --dry-run
pnpm devtree gc
```

Dry-run first, then remove orphaned dependency resources created by deleted worktrees.

## Common Mistakes

### CRITICAL Start Vite directly instead of devtree

Wrong:

```json
{
  "scripts": {
    "dev": "vp dev"
  }
}
```

```bash
pnpm dev
```

Correct:

```json
{
  "scripts": {
    "devtree": "devtree"
  }
}
```

```bash
pnpm devtree dev
```

Starting raw Vite skips devtree's portless wrapping and runtime env injection, so multi-worktree isolation disappears.

Source: `README.md`, `src/command-builder.ts:17`

### HIGH Disable portless and expect APP_URL to exist

Wrong:

```bash
PORTLESS=0 pnpm devtree dev
```

Correct:

```bash
BETTER_AUTH_URL=http://localhost:3000 PORTLESS=0 pnpm devtree dev
```

When portless is disabled, devtree does not inject the public URL, so callback-based auth flows need an explicit fallback URL.

Source: `src/cli.ts:499`

### HIGH Skip setup when dependencies or hooks matter

Wrong:

```bash
pnpm devtree dev
```

Correct:

```bash
pnpm devtree setup
pnpm devtree dev
```

`dev` starts the app, but `setup` is what starts dependencies and runs `setup`, `migrate`, and `post_setup` hooks.

Source: `README.md`, `src/cli.ts:448`

### MEDIUM Assume gc removes unknown docker projects

Wrong:

```bash
pnpm devtree gc
```

Correct:

```bash
pnpm devtree gc --dry-run
```

Unknown projects without worktree metadata are reported and skipped, so `gc` is not a universal Docker janitor.

Source: `src/gc.ts:356`

### HIGH Tension: portless compatibility versus public URL correctness

Disabling portless can simplify local bootstrapping in odd environments, but it removes the stable public URL contract that devtree normally provides. Agents that take the shortcut need to replace that URL explicitly.

See also: `devtree-set-up-devtree` - setup choices around portless and env injection decide whether runtime URLs work.

See also: `devtree-set-up-devtree` - configuration drives most runtime failures.
