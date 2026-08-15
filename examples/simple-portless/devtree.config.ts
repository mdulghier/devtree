import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "simple-demo",

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
        key: "VITE_DEVTREE_PUBLIC_URL",
        value: instance.public_url,
      },
      {
        kind: "value",
        key: "VITE_DEVTREE_SESSION",
        value: instance.session_name,
      },
    ],
  },
});
