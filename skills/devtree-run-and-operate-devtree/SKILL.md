---
name: devtree-run-and-operate-devtree
description: >
  Start, inspect, troubleshoot, and clean up named Devtree sessions and their
  owned or reused dependency stacks across a main checkout and Git worktrees.
type: core
library: devtree
library_version: "0.5.0"
sources:
  - "mdulghier/devtree:README.md"
  - "mdulghier/devtree:src/cli.ts"
  - "mdulghier/devtree:src/session-options.ts"
  - "mdulghier/devtree:src/environment-registry.ts"
  - "mdulghier/devtree:src/registry.ts"
  - "mdulghier/devtree:src/gc.ts"
---

# Devtree - Run And Operate

## Upgrade a 0.4 project

Stop every Devtree process, then run the interactive migration:

```bash
pnpm devtree upgrade
```

The Clack assistant rewrites legacy config keys, adds the primary endpoint, and
lets the user choose which allocated ports belong to reusable dependencies. It
backs up the config and archives old machine state under `~/.devtree/backups`.
It never deletes Docker containers or volumes; review the reported legacy
Compose projects before removing them.

## Start a session

Validate local prerequisites once, then start development:

```bash
pnpm devtree doctor --fix
pnpm devtree dev
```

The main checkout becomes session `default` and owns its dependency stack. A
linked worktree derives a session name from its branch and reuses `default`.
`dev` starts owned Compose dependencies, waits for health, runs first-time setup
hooks when needed, registers every endpoint route, and launches Vite.

Use the Clack startup flow when the identity or dependency choice should be
confirmed interactively:

```bash
pnpm devtree dev -i
```

Use deterministic flags in scripts and automation:

```bash
pnpm devtree dev --name feature-x
pnpm devtree dev --deps default
pnpm devtree dev --deps reporting
pnpm devtree dev -d
pnpm devtree dev --name reporting -d
pnpm devtree dev -- --open
```

`--deps <name>` reuses a registered stack. Bare `--deps` and `-d` make the
session own an isolated stack. A second live session cannot use the same project
and session name because that would steal its endpoint routes.

Sessions remain saved after shutdown. `devtree env --json` creates or reuses the checkout's selection without starting services; `--shell` emits quoted shell exports. Named selections and dependency owners persist under `~/.devtree`. Stop a live session before changing its identity or dependency selection.

Remove a stopped selection with `devtree session remove`, or pass `--name NAME`. Use `devtree session remove <session-id>` after deleting a checkout; IDs appear in `list --json`. Startup reuses assigned ports and reports occupied ports instead of silently changing them.

With `env.provider: "process"`, all commands pass managed values without generating an env file. Install the optional mise adapter with `devtree mise install`; it loads each checkout's selected environment on the next mise activation.

## Inspect runtime state

Inspect the current checkout's resolved project, session, dependency owner, and
all endpoints:

```bash
pnpm devtree info
pnpm devtree info --name feature-x --deps default
```

List every saved Devtree session, including stopped sessions, from any directory:

```bash
pnpx devtree list
pnpx devtree list --json
```

The table includes project, session, status, dependency owner, primary URL, and
worktree path. JSON also includes all endpoints and process identifiers.

## Manage dependencies safely

Only a dependency owner may mutate its stack:

```bash
pnpm devtree deps start
pnpm devtree deps stop
```

A consumer may follow Compose logs because its dependency scope resolves to the
owner's project:

```bash
pnpm devtree deps logs
```

If a reused stack is missing, start the owner session or restart the consumer
with `-d`. Do not silently fall back to a new stack; that changes data and service
identity underneath the application.

Use explicit setup from the owner when hooks must be rerun:

```bash
pnpm devtree setup
```

Consumers cannot run setup, migrations, start, or stop against another session's
stack.

## Routing and remote access

Portless is the default. Devtree creates an alias for every endpoint and removes
only those aliases when the session exits.

For Caddy and Tailscale proxy configuration, run the setup wizard once:

```bash
pnpm devtree setup --interactive
```

Inspect or remove only Devtree's persisted Tailscale mapping:

```bash
pnpm devtree tailscale status
pnpm devtree tailscale remove
```

Do not start Vite directly. That skips managed environment values, stable port
allocation, session registration, and endpoint aliases.

## Garbage collection

Preview first:

```bash
pnpm devtree gc --dry-run
pnpm devtree gc
```

Garbage collection removes dependency resources whose owner worktree is gone. It
keeps stacks used by live sessions even if the original owner worktree has been
deleted, and it skips resources without enough Devtree metadata.

## Troubleshooting order

1. Run `pnpm devtree info` to confirm the resolved identities and endpoints.
2. Run `pnpm devtree doctor` to check Git, Vite, routing, Docker, and Tailscale.
3. Run `pnpx devtree list` to detect an existing session with the same name.
4. If reuse fails, confirm the owner appears in the dependency registry by
   starting its session once.
5. Use `pnpm devtree dev -d` only when an isolated dependency stack is actually
   intended.
6. Run `pnpm devtree gc --dry-run` before removing stale Docker resources.
