# Devtree examples

Choose the smallest setup that meets your needs:

- [Simple Portless](./simple-portless/README.md) runs locally with predictable
  `.localhost` URLs. Start here.
- [Caddy and hosts files](./caddy-hosts/README.md) uses the same custom URL on the
  development machine and other machines on a Tailscale network. It also shows
  owned and reusable PostgreSQL and Redis dependency stacks.

- [mise](./mise/README.md) loads session values into your shell and runs Vite
  through a mise task without generating an env file.

All examples link to the Devtree source in this repository and include complete
installation, startup, session, worktree, and cleanup instructions.
