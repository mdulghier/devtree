# Devtree

Run the same Vite application from multiple Git worktrees without URL, port, environment, or dependency collisions.

By default, every checkout gets a predictable `.localhost` URL:

```text
Main checkout
http://web-ui.localhost:1355

Feature worktree
http://feature-123.web-ui.localhost:1355
```

This setup uses Portless and works without custom DNS, Tailscale, or Caddy.

When the application also needs to be reachable from other machines, you can switch to Caddy and use the same custom URL locally and over Tailscale:

```text
http://web-ui.alice.dev.example.com:1355
http://feature-123--web-ui.alice.dev.example.com:1355
```

Start with the quick setup below. If `.localhost` is enough, you can stop there. When the project grows, you can add [access over Tailscale](#use-the-same-url-over-tailscale) and [separate Docker services for every worktree](#add-docker-services-for-each-worktree).

If you prefer to start from a working application, the [`examples`](./examples/README.md) folder contains:

- A minimal Vite application using Portless and `.localhost` URLs.
- A complete Caddy, Tailscale, hosts-file, PostgreSQL, and Redis setup.

## What Devtree adds to Portless

Portless does one important job: it gives a running application a friendly local URL and sends browser requests to the right port.

Devtree uses Portless for that job in the basic setup, then keeps the rest of the checkout in sync with the same worktree name.

With Devtree:

- `APP_URL` is written correctly in each worktree's `.env.local`.
- Vite and local dependencies receive separate ports.
- Docker containers, networks, and volumes receive separate names.
- Setup commands and local services start the same way in every checkout.
- Deleted worktrees can have their leftover resources cleaned up safely.

For example, the main checkout can receive:

```dotenv
APP_URL=http://web-ui.localhost:1355
```

while a feature worktree automatically receives:

```dotenv
APP_URL=http://feature-123.web-ui.localhost:1355
```

You do not need to edit environment files, choose ports, or rename Docker resources each time you create a worktree. Portless handles the local web address; Devtree coordinates the complete development setup around it.

## Quick start

### Prerequisites

You need:

- Node.js 24 or newer.
- Git.
- pnpm.
- Vite or VitePlus.

### 1. Install Devtree and Portless

From the application repository:

```bash
pnpm add -D devtree portless
```

Portless provides the shared local port and `.localhost` URLs.

### 2. Create `devtree.config.ts`

Add this file at the repository root:

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "web-ui",

  dev_server: {
    runner: "vite",
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

Use `runner: "vite-plus"` instead if the project runs VitePlus.

Devtree writes its environment values to `.env.local`. Existing values outside the Devtree section are left alone.

### 3. Register the Vite plugin

Update the project's Vite configuration:

```ts
import { defineConfig } from "vite";
import { devtree_vite_plugins } from "devtree/vite";

import devtree_config from "./devtree.config.ts";

export default defineConfig({
  plugins: [...(await devtree_vite_plugins(devtree_config))],
});
```

VitePlus projects can keep importing `defineConfig` from `vite-plus`.

### 4. Add a package script

```json
{
  "scripts": {
    "devtree": "devtree"
  }
}
```

Use this command instead of starting Vite directly. Devtree needs to prepare the checkout and register its URL before Vite starts.

### 5. Prepare the checkout

Run:

```bash
pnpm devtree doctor --fix
pnpm devtree setup
```

`doctor --fix` checks the project and starts Portless when necessary.

`setup` writes the Devtree section of `.env.local`, starts configured dependencies, and runs project setup commands.

### 6. Start development

```bash
pnpm devtree dev
```

Open:

```text
http://web-ui.localhost:1355
```

Inspect the current checkout at any time:

```bash
pnpm devtree info
```

## Using Git worktrees

Create a worktree as usual:

```bash
git worktree add ../web-ui-feature-123 -b feature-123
cd ../web-ui-feature-123
pnpm install
pnpm devtree setup
pnpm devtree dev
```

The main checkout remains available at:

```text
http://web-ui.localhost:1355
```

The worktree receives its own URL:

```text
http://feature-123.web-ui.localhost:1355
```

Both checkouts can run at the same time.

## Use the same URL over Tailscale

The default `.localhost` URLs only work on the development machine. Switch to Caddy when teammates, test devices, or other computers on your Tailscale network need to open the application.

The interactive setup keeps machine-specific values in `.devtree.local.yml`; no shell environment variables or repository wrapper scripts are required. Vite remains available only on the development machine. Caddy receives requests on one shared port and sends each hostname to the correct worktree.

```text
Browser on this machine or another Tailscale machine
  ↓
Caddy on port 1355
  ↓
The Vite process for the requested hostname
```

There is one Caddy process and one Tailscale forwarding rule per developer machine. Devtree manages that shared forwarding rule. Starting another worktree only adds another Caddy route.

### Interactive setup

Install Caddy and Tailscale first. On macOS:

```bash
brew install caddy
```

Install Tailscale, sign in, and make sure the machine is connected to the correct Tailscale network.

Run:

```bash
pnpm devtree setup --interactive
```

The wizard detects the Tailscale machine name and address, asks for the shared development domain and port, previews the resulting wildcard DNS record, and asks for confirmation before writing anything. It creates:

```yaml
# .devtree.yml — commit this file
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
# .devtree.local.yml — machine-specific and ignored by Git
version: 1
routing:
  machine_name: alice
```

Devtree adds the local file to the repository's Git exclude file. Linked worktrees reuse the primary worktree's `.devtree.local.yml` unless they deliberately contain their own override.

The wizard prints the exact wildcard record to create:

```text
*.alice.dev.example.com → 100.101.102.103
```

Configure that record and press Enter to let the wizard verify DNS and finish normal project setup. Type `later` to save the files without waiting; after DNS is ready, run:

```bash
pnpm devtree setup
```

Then start the application:

```bash
pnpm devtree dev
```

Portless and Caddy cannot listen on the same port. If Portless is already using `1355`, the setup reports the conflict actionably; stop that listener or select another port in the wizard.

After startup, Devtree prints the exact application URL prominently. This is the URL to open; the machine-level TCP target alone is not sufficient because Caddy also needs the application hostname in the HTTP `Host` header:

```text
[devtree] Tailscale Serve tcp:1355 -> localhost:1355
[devtree] Tailscale application URL http://web-ui.alice.dev.example.com:1355

Open http://web-ui.alice.dev.example.com:1355
Tailscale hostname: web-ui.alice.dev.example.com
Tailscale port: 1355
```

The main checkout is now available at:

```text
http://web-ui.alice.dev.example.com:1355
```

A worktree named `feature-123` is available at:

```text
http://feature-123--web-ui.alice.dev.example.com:1355
```

These exact URLs work on the development machine and from other allowed machines on the Tailscale network.

Discover the same URL later, including from a fresh shell, with:

```bash
pnpm devtree info
```

The output includes `Local URL`, `Tailscale application URL`, `Tailscale application hostname`, `Tailscale application port`, and the active Serve mapping. Devtree persists this resolved routing state under `~/.devtree/routing-state.json`; consumers should use the CLI rather than reading that implementation file directly.

Devtree converts uppercase letters, slashes, punctuation, and long branch names into safe hostname labels. It adds a short, stable suffix when two converted names could otherwise be the same.

### Non-interactive configuration

Automation and developers who prefer declarative setup can create `.devtree.yml` and `.devtree.local.yml` directly using the schemas above, then run ordinary `devtree setup` or `devtree dev`. The local file wins when both files define the same supported value. Existing `routing.hostname` callbacks remain supported as the advanced escape hatch.

`routing.hostname_suffix` can replace `base_domain` plus `machine_name` when the complete wildcard suffix does not follow Devtree's standard naming pattern:

```yaml
routing:
  hostname_suffix: apps.alice.internal.example
```

No `sslip.io` dependency is required. It can still be used explicitly by setting a compatible `hostname_suffix` yourself.

For a small setup without wildcard DNS, `pnpm devtree hosts` prints the exact local and tailnet hosts-file entries. Hosts files require one entry per worktree; DNS is preferable when worktrees are created frequently.

### Multiple worktrees share the proxy

For example, start the main checkout and a feature worktree in separate terminals:

```bash
# Main checkout
pnpm devtree dev

# ../web-ui-feature-123
pnpm devtree setup
pnpm devtree dev
```

With the YAML configuration above, they are available concurrently at:

```text
http://web-ui.alice.dev.example.com:1355
http://feature-123--web-ui.alice.dev.example.com:1355
```

Both use one Caddy listener and one Tailscale TCP mapping. Stopping either development process removes only that worktree's Caddy route; it does not remove the shared Tailscale mapping.

### Inspect or remove the owned mapping

Inspect the desired mapping, live Serve route, ownership, and number of recorded worktrees with:

```bash
pnpm devtree tailscale status
```

When the shared mapping is no longer wanted, remove it explicitly with:

```bash
pnpm devtree tailscale remove
```

Removal uses `tailscale serve --tcp=<port> --yes off`, affecting only the configured TCP port. Devtree permits removal only when its persisted ownership record and the live mapping agree exactly. If the matching route existed before Devtree first saw it, Devtree treats it as external and refuses to remove it. Conflicting mappings are also left untouched with an error explaining how to choose another `tailscale.serve_port` or resolve the conflict manually.

### Migrate away from a custom wrapper

Suppose a repository currently starts development through a wrapper like this:

```bash
TAILSCALE_IP=$(tailscale ip -4)
tailscale serve --tcp="$CADDY_PORT" --bg --yes "tcp://localhost:$CADDY_PORT"
DEVTREE_PUBLIC_HOSTNAME="web-ui.$TAILSCALE_IP.sslip.io" pnpm devtree dev
```

Delete that wrapper and run the interactive setup:

```bash
pnpm devtree setup --interactive
```

Commit `.devtree.yml`, leave `.devtree.local.yml` uncommitted, and use `pnpm devtree dev`. Devtree now discovers the Tailscale IPv4 address, validates the application hostname, owns the Serve lifecycle, persists the resolved URL, and prints it during startup and through `devtree info`.

## Add Docker services for each worktree

Once the basic setup is working, Devtree can also keep databases, caches, and other Docker services separate between worktrees.

Install Docker and make sure it is running before continuing.

The important part is that the application and Docker Compose receive the same worktree-specific values:

```text
Current worktree
  ↓
Devtree writes .env.local
  ├── Vite reads DATABASE_URL and REDIS_URL
  └── Docker Compose reads DATABASE_PORT and REDIS_PORT
        ↓
      Separate containers, network, and volumes
```

### 1. Add the services to `docker-compose.yml`

```yaml
services:
  database:
    image: postgres:17
    ports:
      - "${DATABASE_PORT}:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 2s
      timeout: 2s
      retries: 20
    volumes:
      - database-data:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "${REDIS_PORT}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 20

volumes:
  database-data:
```

### 2. Add the environment values and Compose dependency

Update `devtree.config.ts`:

```ts
import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "web-ui",

  dev_server: {
    runner: "vite",
  },

  env: {
    provider: "dotenv",
    entries: ({ instance }) => {
      const database_port = instance.allocate_port("postgres", 5400);
      const redis_port = instance.allocate_port("redis", 6300);

      return [
        {
          kind: "value",
          key: "APP_URL",
          value: instance.public_url,
        },
        {
          kind: "value",
          key: "DATABASE_PORT",
          value: String(database_port),
        },
        {
          kind: "value",
          key: "DATABASE_URL",
          value: `postgresql://app:app@127.0.0.1:${database_port}/app`,
        },
        {
          kind: "value",
          key: "REDIS_PORT",
          value: String(redis_port),
        },
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
});
```

Devtree chooses stable ports for the current worktree and writes them to that worktree's `.env.local`. It also gives the Docker Compose project a unique name. Docker then keeps the containers, network, and `database-data` volume separate from every other worktree.

Manual values outside the Devtree section of `.env.local` are preserved, so each checkout can still have its own developer overrides.

### 3. Start the services

Run:

```bash
pnpm devtree setup
pnpm devtree dev
```

`setup` writes `.env.local`, passes those values to Docker Compose, starts PostgreSQL and Redis, and waits for them to be ready. The application then starts with matching connection URLs.

Create another worktree and run the same two commands there. It receives different ports and a different Docker Compose project automatically.

When a worktree is deleted, preview and remove anything it left behind with:

```bash
pnpm devtree gc --dry-run
pnpm devtree gc
```

## Daily workflow

```bash
# Prepare a new checkout or worktree
pnpm devtree setup

# Start the application
pnpm devtree dev

# Show the active URL and checkout names
pnpm devtree info

# Preview cleanup after worktrees have been deleted
pnpm devtree gc --dry-run
```

When something is not reachable, start with:

```bash
pnpm devtree doctor
```

It reports missing environment values, invalid hostnames, Portless or Caddy problems, a disconnected Tailscale client, DNS problems, and Vite settings that would expose the app directly. It does not change DNS or Tailscale permissions.

## HTTP and HTTPS

The default setup and the initial Tailscale setup use plain HTTP on port `1355`. Tailscale encrypts traffic between machines on the Tailscale network.

Trusted HTTPS for custom development domains requires certificates and additional machine setup, so it is not part of the initial setup.

## License

MIT
