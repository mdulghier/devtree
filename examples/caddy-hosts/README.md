# Caddy and hosts files example

This example gives the Vite application one custom URL that works on the
development machine and from other authorized machines on the same Tailscale
network.

With the example values below, the main checkout uses:

```text
http://caddy-demo.alice.devtree.test:1355
```

A worktree named `caddy-worktree` uses:

```text
http://caddy-worktree--caddy-demo.alice.devtree.test:1355
```

Caddy receives both URLs on the shared port and sends each one to the correct
Vite process. Hosts file entries make the names available without setting up DNS.
The example also starts separate PostgreSQL and Redis services for every worktree.

## Before you start

You need:

- Node.js 24 or newer, pnpm, and Git.
- [Caddy](https://caddyserver.com/docs/install).
- Tailscale installed, signed in, and connected on the development machine.
- Tailscale on every other machine that should open the application.
- Docker with Docker Compose available on the development machine.

On macOS, you can install Caddy with:

```bash
brew install caddy
```

The example uses `devtree.test`. The `.test` ending is reserved for examples and
does not need to be a domain you own.

## Start the example

All commands below assume you have cloned the Devtree repository and are at its
root.

This example and the Portless example both use port `1355`, so they cannot run at
the same time. If you previously started the Portless example, stop its shared
proxy before continuing:

```bash
pnpm --dir examples/simple-portless exec portless proxy stop -p 1355
```

### 1. Build the local Devtree package

The example links to the Devtree source in this repository, so build it first:

```bash
pnpm install
pnpm build
```

### 2. Install the example

```bash
cd examples/caddy-hosts
pnpm install
```

### 3. Run interactive setup

```bash
pnpm devtree setup --interactive
```

Accept `devtree.test` as the shared domain and choose a short machine namespace,
such as `alice`. Devtree writes the committed settings to `.devtree.yml` and the
machine namespace to the ignored `.devtree.local.yml`. No shell exports are
required.

Because this example uses hosts files instead of wildcard DNS, type `later` when
the wizard asks whether to continue with verification.

Devtree manages the shared Tailscale mapping itself. It reuses the same mapping
for every worktree and preserves unrelated Serve routes.

### 4. Print the hosts file entries

```bash
pnpm devtree hosts
```

Devtree prints two lines for the current checkout:

```text
Add to the hosts file on this development machine:
127.0.0.1 caddy-demo.alice.devtree.test

Add to the hosts file on other Tailscale machines:
100.101.102.103 caddy-demo.alice.devtree.test
```

The Tailscale address will be the real address of your development machine, not
the example address shown above.

Copy the `127.0.0.1` line to the hosts file on the development machine. Copy the
Tailscale line to the hosts file on every other machine that should open the app.

Hosts file locations:

- macOS and Linux: `/etc/hosts`
- Windows: `C:\Windows\System32\drivers\etc\hosts`

Editing this file normally requires administrator access. On macOS or Linux, for
example, open it with:

```bash
sudo nano /etc/hosts
```

Devtree prints the entries but does not request administrator access or edit the
file for you.

### 5. Check and prepare the checkout

After adding the hosts file entries, run:

```bash
pnpm devtree setup
```

The command verifies Caddy, Tailscale, and hostname resolution, reconciles the shared
mapping, writes this checkout's URL and dependency ports to `.env.local`, and starts
PostgreSQL and Redis through Docker Compose.

Devtree gives the checkout its own Compose project, containers, network, database
volume, and host ports. A second worktree can therefore run the same services at
the same time without sharing data or ports.

Open `.env.local` to see the values shared by Vite and Docker Compose. The exact
ports vary by checkout, but the Devtree-managed section includes values like:

```dotenv
DATABASE_PORT=5891
DATABASE_URL=postgresql://app:app@127.0.0.1:5891/app
REDIS_PORT=6712
REDIS_URL=redis://127.0.0.1:6712
```

You can keep your own settings outside the Devtree-managed section. Devtree updates
its section during setup and leaves the rest of the file alone.

### 6. Start Vite

```bash
pnpm devtree dev
```

Open
[http://caddy-demo.alice.devtree.test:1355](http://caddy-demo.alice.devtree.test:1355)
on the development machine. Open the exact same URL on another machine after
adding its hosts file entry.

The page shows its configured hostname, URL, checkout identity, PostgreSQL port,
and Redis port so you can confirm that Caddy and the dependency setup reached the
correct checkout. The demonstration application displays the ports but does not
connect to either service. Full connection URLs remain server-side in `.env.local`
instead of being exposed to browser code.

## Run a second checkout at the same time

Open another terminal at the root of the original Devtree repository. The linked
worktree automatically reuses the primary worktree's `.devtree.local.yml`:

```bash
git worktree add ../devtree-caddy-example -b caddy-worktree
cd ../devtree-caddy-example
pnpm install
pnpm build
cd examples/caddy-hosts
pnpm install
pnpm devtree hosts
```

Copy the newly printed worktree entry to the hosts file on the development machine
and every remote machine. Hosts files do not support wildcard entries, so every
worktree hostname needs its own line.

Then start the worktree:

```bash
pnpm devtree setup
pnpm devtree dev
```

Open
[http://caddy-worktree--caddy-demo.alice.devtree.test:1355](http://caddy-worktree--caddy-demo.alice.devtree.test:1355).
The main checkout remains available at its original URL.

## What each part does

- Devtree chooses the checkout identity, local Vite port, hostname, and URL. It
  keeps those values consistent in Caddy, Vite, `.env.local`, Docker Compose, and
  command output.
- Caddy listens on port `1355` and sends each hostname to its Vite process.
- The hosts files tell each machine which IP address belongs to each hostname.
- Tailscale carries traffic from another authorized machine to Caddy.
- Docker Compose starts a separate PostgreSQL database and Redis service for each
  checkout using the ports Devtree wrote to `.env.local`.

There is one Caddy process and one Tailscale forwarding rule on the development
machine. Worktrees add routes and hosts file entries, not more shared processes.

## Useful commands

Run these from `examples/caddy-hosts` in the checkout you want to inspect:

```bash
# Show the URL, hostname, routing provider, and checkout identity
pnpm devtree info

# Inspect the live shared Serve mapping and its ownership
pnpm devtree tailscale status

# Print the exact local and remote hosts file entries
pnpm devtree hosts

# Check the setup without changing it
pnpm devtree doctor

# Stop this checkout's PostgreSQL and Redis containers
pnpm devtree deps stop
```

When the entire example no longer needs its shared mapping, remove only the
Devtree-owned TCP port with `pnpm devtree tailscale remove`. Devtree refuses if it
cannot prove ownership and never resets or removes unrelated Serve routes.

Stop the development server with `Ctrl+C`.

Before removing the demonstration worktree, stop its containers from that
worktree's `examples/caddy-hosts` directory:

```bash
pnpm devtree deps stop
```

Also remove its line from each hosts file. Then remove the worktree from the
original repository root:

```bash
git worktree remove ../devtree-caddy-example
```

## Files worth reading

- `.devtree.yml` defines the shared Caddy and Tailscale policy.
- `.devtree.local.yml` stores the ignored machine namespace created by setup.
- `devtree.config.ts` defines application environment values and dependencies.
- `docker-compose.yml` defines the PostgreSQL and Redis services.
- `vite.config.ts` adds the Devtree Vite plugin.
- `src/main.ts` displays the values received by the application.
