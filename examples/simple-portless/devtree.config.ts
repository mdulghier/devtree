import { define_devtree_config } from "devtree";

export default define_devtree_config({
  app_name: "simple-demo",

  dev_server: {
    runner: "vite",
  },

  env: {
    provider: "dotenv",
    entries: ({ instance }) => [
      {
        kind: "value",
        key: "VITE_DEVTREE_PUBLIC_URL",
        value: instance.public_url,
      },
      {
        kind: "value",
        key: "VITE_DEVTREE_WORKTREE",
        value: instance.worktree_slug ?? "main checkout",
      },
    ],
  },
});
