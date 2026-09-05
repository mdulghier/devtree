# Devtree

Run the same project in multiple checkouts without fighting over ports, URLs, or
Docker state.

The main checkout runs as `default` and owns its dependencies. Worktrees get
their own name and URL, but reuse the `default` database and brokers unless you
pass `-d`. A project can also expose several services, such as a UI and API,
under separate local domains.

## URLs

Suppose a project named `acme-cloud` exposes a primary `ui` endpoint and an `api` endpoint.

The default session uses:

```text
http://acme-cloud.localhost:1355
http://api.acme-cloud.localhost:1355
```

A session named `billing-redesign` uses:

```text
http://billing-redesign.acme-cloud.localhost:1355
http://billing-redesign.api.acme-cloud.localhost:1355
```

The primary endpoint omits its endpoint name. Secondary endpoints include it. This keeps the common URL short without making multiple endpoints ambiguous.

Caddy uses one flattened DNS label so a single wildcard record covers every endpoint:

```text
http://billing-redesign--acme-cloud.alice.dev.example.com:1355
http://billing-redesign--api--acme-cloud.alice.dev.example.com:1355
```

## Quick start

### Prerequisites

You need Node.js 24 or newer, Git, pnpm, and Vite or VitePlus. Install Devtree and Portless in the application repository:

```bash
pnpm add -D devtree portless
```

### Configure the project

Create `devtree.config.ts` at the repository root:

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "acme-cloud",

  dev_server: {
    runner: "vite",
  },

  endpoints: {
    ui: {
      primary: true,
      target: { kind: "dev-server" },
    },
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

Use `runner: "vite-plus"` for VitePlus projects.

Register the Vite plugin:

```ts
import { defineConfig } from "vite";
import { devtree_vite_plugins } from "devtree/vite";

import devtree_config from "./devtree.config.ts";

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
});
```

Add a package script:

```json
{
  "scripts": {
    "dev": "devtree dev",
    "devtree": "devtree"
  }
}
```

Prepare local routing once, then start development:

```bash
pnpm devtree doctor --fix
pnpm devtree dev
```

With the `dev` script above, `pnpm dev` is the short path for the default behavior.
Use `pnpm devtree dev` when passing Devtree-specific flags.

The main checkout starts the `default` session and owns its dependency stack. A linked worktree derives its session name from its branch and reuses the `default` stack.

## Start sessions

### Interactive mode

Use interactive mode to choose the session name and dependency stack with guided prompts:

```bash
pnpm devtree dev --interactive
pnpm devtree dev -i
```

```text
┌  Devtree
│
◇  Session name
│  billing-redesign
│
◇  Dependency stack
│  Reuse default
│
│  Project       acme-cloud
│  Session       billing-redesign
│  Dependencies  default
│  URL           http://billing-redesign.acme-cloud.localhost:1355
│
└  Starting development environment
```

Explicit flags resolve the matching prompt:

```bash
pnpm devtree dev -i --name billing-redesign  # Ask only about dependencies
pnpm devtree dev -i --deps default           # Ask only about the session name
pnpm devtree dev -i --name billing-redesign -d
```

When every option is explicit, interactive mode prints the resolved summary and starts without asking redundant questions. Cancelling a prompt exits without writing environment files, registering routes, or starting dependencies.

### Deterministic commands

The same choices are available without prompts:

```bash
pnpm devtree dev                         # Main owns default; worktrees reuse default
pnpm devtree dev --name billing-redesign
pnpm devtree dev --deps reporting       # Reuse the stack owned by reporting
pnpm devtree dev --deps                 # Own an isolated stack
pnpm devtree dev -d                     # Short form of bare --deps
pnpm devtree dev --name reporting -d    # Named session with its own stack
pnpm devtree dev -- --open              # Pass arguments after -- to Vite
```

In a non-interactive terminal Devtree never prompts. It uses the documented defaults or fails with an actionable message when the requested dependency stack does not exist.

Session names are unique within a project. Devtree refuses to start a second live session with the same name instead of silently stealing its Portless or Caddy routes.
One checkout may run only one live session at a time because its managed environment file is checkout-local.

### Use the same session in other commands

`dev`, `info`, `hosts`, `setup`, `deps`, `env`, and `exec` resolve the session
from the current checkout. Explicit flags take precedence; otherwise commands
follow its live session, including its dependency owner. With no live session,
they use the checkout defaults described above. Session choices are not saved
after the session exits. Automatic discovery requires the environment registry.

Selecting a different `--name` uses that session's checkout defaults unless you
also select dependencies. Selecting the current live name retains its dependency
owner. `--deps OWNER` or `-d` overrides dependencies without changing the selected
session name.

For example, start `pnpm devtree dev --name billing -d` in one terminal. From
another terminal in the same checkout:

```bash
pnpm devtree info                       # Shows billing and its isolated stack
pnpm devtree deps logs                  # Inspects billing's dependencies
pnpm devtree exec -- pnpm test          # Uses billing's URLs and environment
pnpm devtree exec -- pnpm db:studio
```

`exec` runs the command from the project root, forwards its exit status, and
neither starts dependencies nor writes an environment file. It supports the
configured Varlock wrapper. The command must follow `--`.

`info`, `hosts`, and `env show` do not write environment files. Use `env write`
to explicitly sync one. A conflicting selection cannot rewrite the environment
file while another session runs in the checkout.

Session flags also work for dependency lifecycle commands after a session exits:

```bash
pnpm devtree setup --name billing -d
pnpm devtree deps stop --name billing -d
pnpm devtree env write --name billing -d
```

Ownership and live-consumer protections still apply. Interactive `dev -i` uses
the resolved session as its initial selection; `setup -i` remains the routing
configuration wizard.

### Configure the default session name

The primary checkout defaults to `default`. A linked worktree prefers the branch name and falls back to the worktree name. Override that policy with a resolver:

```ts
export default define_devtree_config({
  project_name: "acme-cloud",

  session: {
    name: ({ default_name, branch_name }) => branch_name?.replace(/^feature\//, "") ?? default_name,
  },

  // ...
});
```

`--name` has higher precedence than the resolver.

## Multiple web endpoints

One development command may start several services. Declare every web endpoint that Devtree should route:

```ts
export default define_devtree_config({
  project_name: "acme-cloud",

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

  // ...
});
```

Exactly one endpoint is primary and exactly one endpoint targets the Devtree-managed Vite process. Other endpoints target fixed local ports. They may be started by Turbo, another task runner, or a `pre_dev` hook; Devtree owns their public routes, not their child-process lifecycle.

Endpoint information is available to environment callbacks:

```ts
env: {
  provider: "dotenv",
  entries: ({ instance }) => [
    { kind: "value", key: "UI_URL", value: instance.endpoints.ui.public_url },
    { kind: "value", key: "API_URL", value: instance.endpoints.api.public_url },
  ],
},
```

`instance.public_url` and `instance.public_hostname` refer to the primary endpoint.

Customize complete endpoint hostnames with the routing resolver:

```ts
routing: {
  hostname: ({ project_name, session_name, endpoint_name, is_primary_endpoint }) => {
    const endpoint = is_primary_endpoint ? "" : `-${endpoint_name}`;
    return `${session_name}${endpoint}.${project_name}.internal.example`;
  },
},
```

## Dependency stacks

Dependencies are owned by a named session and may be reused by other sessions in the same project.

Application ports and dependency ports use different allocation scopes:

```ts
export default define_devtree_config({
  project_name: "acme-cloud",

  env: {
    provider: "dotenv",
    entries: ({ instance, dependencies }) => {
      const api_port = instance.allocate_port("api", 3000);
      const database_port = dependencies.allocate_port("postgres", 5400);
      const redis_port = dependencies.allocate_port("redis", 6300);

      return [
        { kind: "value", key: "API_PORT", value: String(api_port) },
        { kind: "value", key: "DATABASE_PORT", value: String(database_port) },
        {
          kind: "value",
          key: "DATABASE_URL",
          value: `postgresql://app:app@127.0.0.1:${database_port}/app`,
        },
        { kind: "value", key: "REDIS_PORT", value: String(redis_port) },
        {
          kind: "value",
          key: "REDIS_URL",
          value: `redis://127.0.0.1:${redis_port}`,
        },
      ];
    },
  },

  dependencies: [
    {
      kind: "compose",
      name: "services",
      file_path: "docker-compose.yml",
      services: ["database", "redis"],
    },
  ],

  // ...
});
```

When a session owns its dependencies, `devtree dev` starts the Compose project and waits for health. The first initialization also runs `setup`, `migrate`, and `post_setup` hooks. Use `devtree setup` to reconcile the owned stack and rerun those hooks explicitly.

When a session reuses another stack, Devtree:

- resolves dependency ports and Compose names from the owner;
- verifies that the named stack has been registered;
- never starts, stops, migrates, or reconfigures it;
- runs only the consumer session's `pre_dev` hooks.

Command dependencies are not shareable because they have no declarative resource or health contract. A session may own command dependencies, but attempting to reuse them fails clearly.

Only an owner may run lifecycle-changing dependency commands:

```bash
pnpm devtree deps start
pnpm devtree deps stop
```

Consumers may inspect Compose logs but cannot stop another session's stack.
Owners also cannot stop, set up, or migrate a stack while any live session is
using it.

## Inspect sessions

List every live Devtree session from any directory:

```bash
pnpx devtree list
pnpx devtree list --json
```

```text
PROJECT     SESSION            STATUS   DEPS       URL                                                PATH
acme-cloud  default            running  self       http://acme-cloud.localhost:1355                    ~/code/acme-cloud
acme-cloud  billing-redesign   running  default    http://billing-redesign.acme-cloud.localhost:1355   /tmp/acme-billing
```

The JSON output includes the project, session, dependency owner, every endpoint, process IDs, routing provider, and worktree path.

Inspect the current checkout and resolved options with:

```bash
pnpm devtree info
pnpm devtree info --name billing-redesign --deps default
```

`info` prints every endpoint and the resolved dependency owner.

Environment registration is enabled by default. Disable it in `.devtree.yml` when a project must not appear in the machine-wide list:

```yaml
version: 1
registry:
  enabled: false
```

## Portless and Caddy

Portless is the default provider. Devtree allocates a stable local port for the managed Vite process, registers one Portless alias for every endpoint, and removes only those aliases when the session exits.

For custom domains and access over Tailscale, run:

```bash
pnpm devtree setup --interactive
```

The Clack wizard configures Caddy, the shared development domain, the machine name, and Tailscale proxy routing. It writes shared settings to `.devtree.yml` and machine-specific settings to the ignored `.devtree.local.yml`.

Example configuration:

```yaml
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

Create this wildcard DNS record:

```text
*.alice.dev.example.com → 100.101.102.103
```

One Caddy process and one Tailscale TCP mapping serve every project, session, and endpoint. Devtree creates one Caddy route per endpoint and removes only the current session's routes when it exits.

When using hosts files instead of wildcard DNS, print every endpoint entry for
the resolved or explicitly named session:

```bash
pnpm devtree hosts
pnpm devtree hosts --name billing-redesign
```

Inspect or remove Devtree's owned Tailscale mapping:

```bash
pnpm devtree tailscale status
pnpm devtree tailscale remove
```

## Environment files

Devtree writes managed values to `.env.local` by default. Existing content outside the managed block is preserved.

Every app process receives runtime variables including:

```text
DEVTREE_ACTIVE=1
DEVTREE_PROJECT_NAME=acme-cloud
DEVTREE_SESSION_NAME=billing-redesign
DEVTREE_DEPENDENCY_OWNER=default
DEVTREE_PUBLIC_URL=http://billing-redesign.acme-cloud.localhost:1355
DEVTREE_PUBLIC_HOSTNAME=billing-redesign.acme-cloud.localhost
```

Endpoint-specific values belong in the project's explicit `env.entries` callback because projects choose their own variable names.

## Cleanup

Preview and remove dependency resources left by deleted worktrees:

```bash
pnpm devtree gc --dry-run
pnpm devtree gc
```

Garbage collection understands named dependency ownership and live consumers. It never removes a stack that belongs to an existing owner worktree or is used by a live session.

## Upgrade from Devtree 0.4

This release intentionally breaks the 0.4 configuration and machine-state formats.

Stop every running Devtree process, then run the upgrade assistant from the
project:

```bash
pnpm devtree upgrade
```

The Clack assistant:

- chooses the new project name and primary endpoint name;
- replaces `app_name` and `namespace` with `project_name`;
- adds the primary development-server endpoint;
- lets you choose which `instance.allocate_port(...)` calls belong to the
  reusable dependency stack;
- adds `dependencies` to the matching callback parameters;
- backs up `devtree.config.ts` before writing it;
- moves legacy machine state into a timestamped directory under
  `~/.devtree/backups` instead of deleting it;
- reports the remaining manual changes it can detect.

The command refuses to continue while a registered Devtree process is still
alive. It does not delete Docker containers or volumes. Legacy Compose project
names are included in the final report so you can remove them after checking
whether their data is still needed.

The command is safe to run again. When the config and machine state are already
current, it exits without writing or prompting for confirmation.

The assistant deliberately leaves two changes for review because guessing would
be unsafe:

1. Update custom `routing.hostname` callbacks to handle project, session, and
   endpoint names.
2. Replace worktree-specific labels in application code with session names where
   appropriate.

Before:

```ts
export default define_devtree_config({
  app_name: "web-ui",
  env: {
    provider: "dotenv",
    entries: ({ instance }) => {
      const database_port = instance.allocate_port("postgres", 5400);
      return [
        { kind: "value", key: "APP_URL", value: instance.public_url },
        { kind: "value", key: "DATABASE_PORT", value: String(database_port) },
      ];
    },
  },
});
```

After:

```ts
export default define_devtree_config({
  project_name: "web-ui",
  endpoints: {
    ui: {
      primary: true,
      target: { kind: "dev-server" },
    },
  },
  env: {
    provider: "dotenv",
    entries: ({ instance, dependencies }) => {
      const database_port = dependencies.allocate_port("postgres", 5400);
      return [
        { kind: "value", key: "APP_URL", value: instance.public_url },
        { kind: "value", key: "DATABASE_PORT", value: String(database_port) },
      ];
    },
  },
});
```

After reviewing the diff, run `pnpm devtree dev -i` to preview the session,
dependency owner, and URLs before startup.

## License

MIT
