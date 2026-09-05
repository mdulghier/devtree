import { define_devtree_config } from "devtree";

export default define_devtree_config({
  project_name: "mise-example",
  dev_server: { runner: { kind: "mise", task: "vite:serve" } },
  env: {
    provider: "process",
    entries: ({ instance }) => [
      { kind: "value", key: "VITE_APP_URL", value: instance.public_url },
      { kind: "value", key: "VITE_SESSION", value: instance.session_name },
    ],
  },
});
