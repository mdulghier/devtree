---
name: devtree-set-up-devtree
description: >
  Set up devtree in a Vite repository: install `devtree`, create
  `devtree.config.ts`, define `env.entries`, choose `dotenv` or `varlock`,
  register `devtree_vite_plugins`, and configure optional `dependencies`
  and `hooks`. Load this when an agent needs to bootstrap worktree-aware
  local development without URL, env, or Docker naming collisions.
type: core
library: devtree
library_version: "0.3.0"
sources:
  - "mdulghier/devtree:README.md"
  - "mdulghier/devtree:src/config.ts"
  - "mdulghier/devtree:src/cli.ts"
  - "mdulghier/devtree:src/vite.ts"
  - "mdulghier/devtree:src/env-file.ts"
  - "mdulghier/devtree:src/instance.ts"
---

# Devtree - Set Up

## Setup

Install `devtree` and register both the config file and the Vite plugin. Devtree defaults to `vite-plus`; set `dev_server.runner` to `vite` for plain Vite apps.

```bash
pnpm add -D devtree vite-plus
```

For plain Vite apps, install `vite` instead and set `dev_server.runner` to `'vite'`.

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  dev_server: {
    runner: 'vite-plus',
  },
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      {
        kind: 'value',
        key: 'APP_URL',
        value: instance.public_url,
      },
      {
        kind: 'value',
        key: 'DATABASE_PORT',
        value: String(instance.allocate_port('postgres', 5400)),
      },
    ],
  },
})
```

```ts
import { defineConfig } from 'vite-plus'
import { devtree_vite_plugins } from 'devtree/vite'

import devtree_config from './devtree.config.ts'

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
})
```

Plain Vite apps can import `defineConfig` from `vite` instead.

```json
{
  "scripts": {
    "devtree": "devtree"
  }
}
```

```bash
pnpm devtree doctor --fix
pnpm devtree setup
```

For guided Caddy and Tailscale proxy configuration, use the interactive setup instead:

```bash
pnpm devtree setup --interactive
```

It writes shared settings to committed `.devtree.yml` and the machine namespace to ignored `.devtree.local.yml`. Plain `setup` remains non-interactive.

## Core Patterns

### Keep env values instance-derived

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
      {
        kind: 'value',
        key: 'REDIS_PORT',
        value: String(instance.allocate_port('redis', 6300)),
      },
    ],
  },
})
```

Use `instance.public_url`, `instance.get_scoped_name()` and `instance.allocate_port()` instead of fixed local values.

For one canonical hostname that is reachable across a tailnet, prefer the interactive setup. Its shared configuration is declarative:

```yaml
# .devtree.yml
version: 1
routing:
  provider: caddy
  base_domain: dev.example.com
  port: 1355
  https: false
tailscale:
  enabled: true
  mode: proxy
```

```yaml
# .devtree.local.yml
version: 1
routing:
  machine_name: alice
```

This produces worktree-aware hostnames such as `my-app.alice.dev.example.com` and `feature-123--my-app.alice.dev.example.com` without machine environment variables. The local file overrides the shared file and is reused by linked worktrees. `routing.hostname_suffix` supports a custom complete wildcard suffix, while the TypeScript `routing.hostname` callback remains the advanced escape hatch.

### Start Docker dependencies through config

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
  dependencies: [
    {
      kind: 'compose',
      name: 'postgres',
      file_path: 'docker-compose.yml',
      project_name: ({ instance }) => instance.get_scoped_name('db'),
      services: ['db'],
    },
  ],
})
```

Compose dependencies are the default way to give each worktree isolated container, network, and volume names.

### Use hooks for repo-specific setup

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
  hooks: {
    migrate: [
      {
        command: ['pnpm', 'db:migrate'],
      },
    ],
    pre_dev: [
      {
        command: ['pnpm', 'codegen'],
      },
    ],
  },
})
```

`setup` runs `setup`, `migrate`, and `post_setup`; `dev` runs `pre_dev` before starting the server.

### Turn on varlock only with its prerequisites

```bash
pnpm add -D varlock @varlock/vite-integration
touch .env.schema
```

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'varlock',
    schema_path: '.env.schema',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
})
```

Keep the simple `dotenv` path as the default; use `varlock` when the repo already wants schema-based env handling.

## Common Mistakes

### CRITICAL Hard-code shared URLs and ports

Wrong:

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: () => [
      { kind: 'value', key: 'APP_URL', value: 'http://localhost:3000' },
      { kind: 'value', key: 'DATABASE_PORT', value: '5432' },
    ],
  },
})
```

Correct:

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
      {
        kind: 'value',
        key: 'DATABASE_PORT',
        value: String(instance.allocate_port('postgres', 5400)),
      },
    ],
  },
})
```

Static values remove the per-worktree isolation that devtree is supposed to enforce.

Source: `README.md`

### HIGH Store manual values inside managed block

Wrong:

```dotenv
# >>> devtree managed env >>>
APP_URL=http://feature-x.my-app.localhost:1355
STRIPE_SECRET_KEY=sk_live_manual_override
# <<< devtree managed env <<<
```

Correct:

```dotenv
# >>> devtree managed env >>>
APP_URL=http://feature-x.my-app.localhost:1355
# <<< devtree managed env <<<

STRIPE_SECRET_KEY=sk_live_manual_override
```

Devtree rewrites the managed block on each run and only preserves custom content outside that block.

Source: `src/env-file.ts:78`

### HIGH Force shared dependency project names

Wrong:

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
  dependencies: [
    {
      kind: 'compose',
      name: 'db',
      project_name: 'my-app',
    },
  ],
})
```

Correct:

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'dotenv',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
  dependencies: [
    {
      kind: 'compose',
      name: 'db',
      project_name: ({ instance }) => instance.get_scoped_name('db'),
    },
  ],
})
```

Static Compose project names silently make multiple worktrees fight over the same Docker resources.

Source: `src/cli.ts:156`

### HIGH Enable varlock without integration prerequisites

Wrong:

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'varlock',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
})
```

Correct:

```bash
pnpm add -D varlock @varlock/vite-integration
touch .env.schema
```

```ts
import { define_devtree_config } from 'devtree'

export default define_devtree_config({
  app_name: 'my-app',
  env: {
    provider: 'varlock',
    schema_path: '.env.schema',
    entries: ({ instance }) => [
      { kind: 'value', key: 'APP_URL', value: instance.public_url },
    ],
  },
})
```

`varlock` mode depends on the CLI, the schema file, and `@varlock/vite-integration`; missing any of them breaks setup or plugin loading.

Source: `src/cli.ts:338`, `src/vite.ts:45`

### HIGH Tension: simple setup versus explicit override freedom

Devtree works best when it owns URL, env, and dependency naming. Agents trying to be “helpful” by hard-coding familiar local values usually delete the whole point of the library.

See also: `devtree-run-and-operate-devtree` - runtime checks expose the fallout from setup shortcuts.
