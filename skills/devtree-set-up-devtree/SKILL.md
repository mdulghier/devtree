---
name: devtree-set-up-devtree
description: >
  Set up Devtree in a Vite repository with named projects, sessions, web
  endpoints, reusable dependency stacks, managed environment values, and
  optional Caddy or Tailscale routing.
type: core
library: devtree
library_version: "0.5.0"
sources:
  - "mdulghier/devtree:README.md"
  - "mdulghier/devtree:src/config.ts"
  - "mdulghier/devtree:src/instance.ts"
  - "mdulghier/devtree:src/cli.ts"
  - "mdulghier/devtree:src/vite.ts"
---

# Devtree - Set Up

## Install and register Devtree

Install Devtree, Portless, and the project's Vite runner:

```bash
pnpm add -D devtree portless vite-plus
```

Use `vite` instead of `vite-plus` when that is the project's runner.

Create `devtree.config.ts`:

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "my-app",

  dev_server: {
    runner: "vite-plus",
  },

  endpoints: {
    ui: {
      primary: true,
      target: { kind: "dev-server" },
    },
    api: {
      target: ({ instance }) => ({
        kind: "port",
        host: "127.0.0.1",
        port: instance.allocate_port("api", 3000),
      }),
    },
  },

  env: {
    provider: "dotenv",
    entries: ({ instance, dependencies }) => {
      const database_port = dependencies.allocate_port("postgres", 5400);

      return [
        { kind: "value", key: "APP_URL", value: instance.public_url },
        { kind: "value", key: "API_URL", value: instance.endpoints.api.public_url },
        { kind: "value", key: "DATABASE_PORT", value: String(database_port) },
      ];
    },
  },
});
```

Exactly one endpoint must be primary and exactly one must target the managed
development server. Other endpoints route to loopback ports; another task runner
or a `pre_dev` hook is responsible for starting those services.

Register the Vite plugin:

```ts
import { defineConfig } from "vite-plus";
import { devtree_vite_plugins } from "devtree/vite";

import devtree_config from "./devtree.config.ts";

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
});
```

Add scripts:

```json
{
  "scripts": {
    "dev": "devtree dev",
    "devtree": "devtree"
  }
}
```

Then validate and start the default session:

```bash
pnpm devtree doctor --fix
pnpm devtree dev
```

## Identity and URL model

Keep project, session, endpoint, and dependency ownership separate.

For project `my-app`, the default primary URL is `my-app.localhost`; its API URL
is `api.my-app.localhost`. Session `feature-x` uses `feature-x.my-app.localhost`
and `feature-x.api.my-app.localhost`.

The main checkout defaults to session `default` and owns its dependencies. A
linked worktree derives a session name from its branch and reuses `default`.
Customize derived names only when repository policy requires it:

```ts
session: {
  name: ({ branch_name, default_name }) =>
    branch_name?.replace(/^feature\//, '') ?? default_name,
},
```

## Dependency stacks

Use the dependency scope for databases, brokers, Compose names, and their ports:

```ts
env: {
  provider: 'dotenv',
  entries: ({ dependencies }) => {
    const port = dependencies.allocate_port('postgres', 5400)
    return [
      { kind: 'value', key: 'DATABASE_PORT', value: String(port) },
      {
        kind: 'value',
        key: 'DATABASE_URL',
        value: `postgresql://app:app@127.0.0.1:${port}/app`,
      },
    ]
  },
},

dependencies: [
  {
    kind: 'compose',
    name: 'services',
    file_path: 'docker-compose.yml',
    services: ['database'],
  },
],
```

Do not set a static Compose project name. The default name is scoped to the
project and dependency owner, allowing several isolated stacks while permitting
intentional reuse.

Command dependencies cannot be reused because they have no declarative resource
or health contract.

## Caddy and Tailscale

Use the Clack setup wizard once for a shared development domain:

```bash
pnpm devtree setup --interactive
```

It writes shared routing policy to `.devtree.yml` and the machine name to ignored
`.devtree.local.yml`. Caddy endpoint names are flattened into one DNS label so a
single wildcard record covers named sessions and all endpoints.

## Avoid these mistakes

- Do not use `app_name` or `namespace`; the configuration key is `project_name`.
- Do not hard-code application URLs or dependency ports.
- Do not allocate dependency ports through `instance.allocate_port`; use
  `dependencies.allocate_port` so consumers resolve the owner's stack.
- Do not expose two endpoints as `{ kind: 'dev-server' }`; Devtree manages one
  Vite process per session.
- Do not place manual secrets inside the Devtree-managed environment block.
- Do not run raw Vite from the project's `dev` script; that bypasses Devtree's
  identity, runtime environment, and endpoint route registration.
