import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "caddy-demo",

  dev_server: {
    runner: "vite",
  },

  env: {
    provider: "dotenv",
    entries: ({ instance }) => {
      const database_port = instance.allocate_port("postgres", 5400);
      const redis_port = instance.allocate_port("redis", 6300);
      const database_url = `postgresql://app:app@127.0.0.1:${database_port}/app`;
      const redis_url = `redis://127.0.0.1:${redis_port}`;

      return [
        {
          kind: "value",
          key: "VITE_DEVTREE_PUBLIC_URL",
          value: instance.public_url,
        },
        {
          kind: "value",
          key: "VITE_DEVTREE_PUBLIC_HOSTNAME",
          value: instance.public_hostname,
        },
        {
          kind: "value",
          key: "VITE_DEVTREE_WORKTREE",
          value: instance.worktree_slug ?? "main checkout",
        },
        {
          kind: "value",
          key: "DATABASE_PORT",
          value: String(database_port),
        },
        {
          kind: "value",
          key: "DATABASE_URL",
          value: database_url,
        },
        {
          kind: "value",
          key: "VITE_DATABASE_PORT",
          value: String(database_port),
        },
        {
          kind: "value",
          key: "REDIS_PORT",
          value: String(redis_port),
        },
        {
          kind: "value",
          key: "REDIS_URL",
          value: redis_url,
        },
        {
          kind: "value",
          key: "VITE_REDIS_PORT",
          value: String(redis_port),
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
