import { createServer } from "node:net";
import type { Resolved_endpoint } from "./instance.ts";

export async function assert_dev_server_port_available(endpoint: Resolved_endpoint) {
  await new Promise<void>((resolve_result, reject_result) => {
    const server = createServer();
    server.once("error", (error) =>
      reject_result(
        new Error(
          `Session port ${endpoint.target_host}:${endpoint.target_port} is unavailable (${error.message}). Stop the process using it, or remove this stopped session with devtree session remove to release its assignment.`,
        ),
      ),
    );
    server.listen(endpoint.target_port, endpoint.target_host, () =>
      server.close((error) => (error ? reject_result(error) : resolve_result())),
    );
  });
}
