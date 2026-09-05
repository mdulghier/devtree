# Devtree with mise

This example loads a persistent Devtree session into your shell and starts Vite through a mise task. The process provider supplies the environment without generating an env file.

From this directory, after building Devtree at the repository root:

```sh
pnpm install
pnpm devtree mise install
mise trust
mise install
pnpm devtree doctor --fix
mise run dev
```

Enable mise activation in your shell as described in the [mise getting-started guide](https://mise.jdx.dev/getting-started.html). Open the public URL printed by Devtree. The page shows the same session and URL as the shell's `VITE_SESSION` and `VITE_APP_URL` variables.

Stop the server, select a different session, and refresh the shell environment:

```sh
pnpm devtree env --json --name billing -d
mise env --json
mise run dev
```

The next mise activation loads `billing`, and startup reuses its saved port. You can inspect assignments with `pnpm devtree list --json` and remove the stopped selection with `pnpm devtree session remove`.

The adapter lives in `~/.devtree/mise/devtree` even if this checkout is deleted. Each checkout needs its own installed Devtree dependency. Rerun `pnpm devtree mise install` to update the adapter.

`vite:serve` must accept Vite flags. Keep it separate from the `dev` task that calls Devtree. No Devtree Vite plugin is required.
