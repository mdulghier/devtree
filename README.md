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

Existing projects with `tailscale.enabled: true` and no `mode` keep their original direct-access behavior. The setup below opts into the shared proxy with `mode: "proxy"`.

The upgraded setup keeps Vite available only on the development machine. Caddy receives browser requests on port `1355` and sends each hostname to the correct Vite process.

```text
Browser on this machine or another Tailscale machine
  ↓
Caddy on port 1355
  ↓
The Vite process for the requested hostname
```

There is one Caddy process and one Tailscale forwarding rule per developer machine. Starting another worktree only adds another Caddy route.

### 1. Install Caddy and Tailscale

On macOS, install Caddy with:

```bash
brew install caddy
```

Install Tailscale, sign in, and make sure the machine is connected to the correct Tailscale network.

### 2. Set the developer name and public domain

Keep machine-specific values out of the project configuration:

```bash
export DEVTREE_DEVELOPER_NAMESPACE=alice
export DEVTREE_PUBLIC_DOMAIN=dev.example.com
```

`DEVTREE_DEVELOPER_NAMESPACE` identifies the developer or development machine. Replace `alice` with a short value that is unique within the team. This keeps two developers from claiming the same application hostname.

`DEVTREE_PUBLIC_DOMAIN` is the shared development domain chosen by the team. Replace `dev.example.com` with a domain your team controls when using DNS. If you use hosts files instead, it can be a private name that every participating machine maps explicitly. It does not need to be open to the public internet.

Together with `app_name: "web-ui"`, these values produce a hostname such as:

```text
web-ui.alice.dev.example.com
```

Keep these values in the machine environment because each developer uses a different name while the project configuration stays the same. Add them to your shell profile so they are available in every checkout.

### 3. Update `devtree.config.ts`

Move the hostname and shared port into `routing` and select Caddy:

```ts
import { define_devtree_config } from "devtree";

function required_env(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required for the Devtree public hostname`);
  }

  return value;
}

export default define_devtree_config({
  app_name: "web-ui",

  routing: {
    provider: {
      kind: "caddy",
    },
    hostname: ({ app_name, worktree_slug }) => {
      const developer_namespace = required_env("DEVTREE_DEVELOPER_NAMESPACE");
      const public_domain = required_env("DEVTREE_PUBLIC_DOMAIN");
      const route_name = worktree_slug ? `${worktree_slug}--${app_name}` : app_name;

      return `${route_name}.${developer_namespace}.${public_domain}`;
    },
    port: 1355,
    https: false,
  },

  tailscale: {
    enabled: true,
    mode: "proxy",
  },

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

The hostname function returns the complete hostname that Devtree uses for Caddy, application URLs, Vite, environment values, and command output.

### 4. Configure DNS or hosts files

DNS is the easiest option when developers create worktrees regularly. Ask your DNS administrator to add a wildcard record for the developer name. It should point to the development machine's Tailscale IP:

```text
*.alice.dev.example.com → Alice's development machine's Tailscale IP
```

This one record covers the main checkout and its worktrees.

For a small setup, you can use hosts files instead of DNS. Devtree can print the exact entries for the current checkout or worktree:

```bash
pnpm devtree hosts
```

For the main checkout, the output looks like this:

```text
Add to the hosts file on this development machine:
127.0.0.1 web-ui.alice.dev.example.com

Add to the hosts file on other Tailscale machines:
100.101.102.103 web-ui.alice.dev.example.com
```

Run the same command from a worktree to get its exact hostname:

```text
Add to the hosts file on this development machine:
127.0.0.1 feature-123--web-ui.alice.dev.example.com

Add to the hosts file on other Tailscale machines:
100.101.102.103 feature-123--web-ui.alice.dev.example.com
```

Devtree gets the second address from `tailscale ip -4`, so you do not need to find or type it yourself. Copy the local entry to the development machine and the Tailscale entry to every other machine that should open the application.

The hosts file is `/etc/hosts` on macOS and Linux, and `C:\Windows\System32\drivers\etc\hosts` on Windows. Editing it normally requires administrator access.

Hosts files do not support wildcard entries. Add a new line on every participating machine whenever you create a worktree with a new hostname. This is practical for testing or a small number of stable worktrees; use wildcard DNS when that manual upkeep becomes inconvenient.

The `hosts` command only prints entries. Devtree checks hostname resolution but does not request administrator access or change DNS, hosts files, or Tailscale permissions.

### 5. Forward the shared port through Tailscale

Run this once on the development machine:

```bash
tailscale serve --tcp=1355 tcp://localhost:1355
```

Do not create a forwarding rule for each worktree.

### 6. Check and start the new setup

Portless and Caddy cannot listen on port `1355` at the same time. If this project previously used the default Portless setup, stop its shared proxy once:

```bash
portless proxy stop -p 1355
```

Run:

```bash
pnpm devtree doctor --fix
pnpm devtree setup
pnpm devtree dev
```

`doctor --fix` checks Caddy, Tailscale, hostname resolution, the required environment values, and the Vite network settings. It starts the Caddy process used by Devtree when necessary.

The main checkout is now available at:

```text
http://web-ui.alice.dev.example.com:1355
```

A worktree named `feature-123` is available at:

```text
http://feature-123--web-ui.alice.dev.example.com:1355
```

These exact URLs work on the development machine and from other allowed machines on the Tailscale network.

Devtree converts uppercase letters, slashes, punctuation, and long branch names into safe hostname labels. It adds a short, stable suffix when two converted names could otherwise be the same.

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
