# Simple Portless example

This is the smallest useful Devtree setup. It runs a plain Vite application with
Portless and gives every named session its own `.localhost` URL.

The default session uses:

```text
http://simple-demo.localhost:1355
```

A session named `portless-worktree` uses:

```text
http://portless-worktree.simple-demo.localhost:1355
```

No custom DNS, hosts file, Caddy, Docker, or Tailscale setup is needed.

## Start the example

You need Node.js 24 or newer, pnpm, and Git.

All commands below assume you have cloned the Devtree repository and are at its
root.

This example and the Caddy example both use port `1355`, so they cannot run at the
same time. If you previously started the Caddy example, stop its shared process
before continuing:

```bash
caddy stop --address 127.0.0.1:2020
```

### 1. Build the local Devtree package

The example links to the Devtree source in this repository, so build it first:

```bash
pnpm install
pnpm build
```

### 2. Install the example

```bash
cd examples/simple-portless
pnpm install
```

Portless is included in the example's development dependencies.

### 3. Check and prepare the project

```bash
pnpm devtree doctor --fix
pnpm devtree setup
```

The first command checks the required tools and starts the shared Portless proxy
when needed. The second writes the default session's values to `.env.local`.

### 4. Start Vite

```bash
pnpm devtree dev
```

Open [http://simple-demo.localhost:1355](http://simple-demo.localhost:1355).
The page shows the configured URL and session name so you can see which process
handled the request.

Leave this command running while you try the worktree below.

## Run a second checkout at the same time

Open another terminal at the root of the Devtree repository, then create a Git
worktree:

```bash
git worktree add ../devtree-portless-example -b portless-worktree
cd ../devtree-portless-example
pnpm install
pnpm build
cd examples/simple-portless
pnpm install
pnpm devtree dev
```

Open
[http://portless-worktree.simple-demo.localhost:1355](http://portless-worktree.simple-demo.localhost:1355).
The original URL remains available at the same time. The worktree derives the
`portless-worktree` session name, and Portless sends each hostname to the right
Vite process.

## Useful commands

Run these from `examples/simple-portless` in the checkout you want to inspect:

```bash
# Show the project, session, URL, and allocated values
pnpm devtree info

# Check the local setup without changing it
pnpm devtree doctor

# Preview resources left by deleted worktrees
pnpm devtree gc --dry-run
```

Stop the development server with `Ctrl+C`.

To remove the demonstration worktree, return to the original repository root:

```bash
git worktree remove ../devtree-portless-example
```

## Files worth reading

- `devtree.config.ts` connects the checkout URL to `.env.local`.
- `vite.config.ts` uses ordinary Vite configuration; Devtree supplies the launch settings.
- `src/main.ts` displays the values received by the application.
