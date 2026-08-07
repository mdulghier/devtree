export const CADDY_DEFAULT_ADMIN_URL = "http://127.0.0.1:2020";
export const CADDY_SERVER_ID = "devtree-server";

export type Caddy_fetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type Caddy_route = {
  "@id": string;
  match: Array<{
    host: string[];
  }>;
  handle: Array<{
    handler: "reverse_proxy";
    upstreams: Array<{
      dial: string;
    }>;
  }>;
  terminal: true;
};

function validate_port(port: number, source: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be an integer from 1 to 65535.`);
  }
}

export function normalize_caddy_admin_url(admin_url = CADDY_DEFAULT_ADMIN_URL) {
  const trimmed_url = admin_url.trim();
  let parsed_url: URL;

  try {
    parsed_url = new URL(trimmed_url);
  } catch {
    throw new Error(`Caddy admin URL "${trimmed_url}" must be a valid URL.`);
  }

  if (
    parsed_url.protocol !== "http:" ||
    parsed_url.username ||
    parsed_url.password ||
    parsed_url.pathname !== "/" ||
    parsed_url.search ||
    parsed_url.hash
  ) {
    throw new Error(
      "Caddy admin URL must be an HTTP origin without credentials, a path, query, or fragment.",
    );
  }

  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed_url.hostname)) {
    throw new Error("Caddy admin URL must use a local host for safe development access.");
  }

  if (!parsed_url.port) {
    throw new Error("Caddy admin URL must include a port.");
  }

  return parsed_url.origin;
}

export function create_caddy_config(
  public_port: number,
  admin_url = CADDY_DEFAULT_ADMIN_URL,
) {
  validate_port(public_port, "Caddy public port");
  const normalized_admin_url = normalize_caddy_admin_url(admin_url);
  const admin = new URL(normalized_admin_url);

  return {
    admin: {
      listen: admin.host,
      config: {
        persist: false,
      },
    },
    apps: {
      http: {
        servers: {
          devtree: {
            "@id": CADDY_SERVER_ID,
            listen: [`127.0.0.1:${public_port}`],
            automatic_https: {
              disable: true,
            },
            routes: [] as Caddy_route[],
          },
        },
      },
    },
  };
}

export function get_caddy_route_id(instance_id: string) {
  const normalized_id = instance_id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (!normalized_id) {
    throw new Error("A non-empty instance ID is required for a Caddy route.");
  }

  return `devtree-route-${normalized_id}`;
}

export function create_caddy_route(options: {
  route_id: string;
  hostname: string;
  upstream_port: number;
}): Caddy_route {
  validate_port(options.upstream_port, "Caddy upstream port");

  if (!options.route_id.trim()) {
    throw new Error("A non-empty route ID is required for a Caddy route.");
  }

  if (!options.hostname.trim()) {
    throw new Error("A non-empty hostname is required for a Caddy route.");
  }

  return {
    "@id": options.route_id,
    match: [
      {
        host: [options.hostname],
      },
    ],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [
          {
            dial: `127.0.0.1:${options.upstream_port}`,
          },
        ],
      },
    ],
    terminal: true,
  };
}

async function request_caddy(
  admin_url: string,
  path: string,
  init: RequestInit,
  fetch_caddy: Caddy_fetch,
  allowed_statuses: number[] = [],
) {
  const normalized_admin_url = normalize_caddy_admin_url(admin_url);
  const headers = new Headers(init.headers);
  let response: Response;

  headers.set("origin", normalized_admin_url);

  try {
    response = await fetch_caddy(`${normalized_admin_url}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach Devtree's Caddy admin API at ${normalized_admin_url}. Run \`pnpm devtree doctor --fix\`. ${message}`,
    );
  }

  if (!response.ok && !allowed_statuses.includes(response.status)) {
    const response_text = (await response.text()).trim();
    const detail = response_text ? ` ${response_text}` : "";
    throw new Error(
      `Caddy admin API ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}.${detail}`,
    );
  }

  return response;
}

export async function is_caddy_ready(
  admin_url = CADDY_DEFAULT_ADMIN_URL,
  fetch_caddy: Caddy_fetch = fetch,
) {
  const response = await request_caddy(
    admin_url,
    `/id/${CADDY_SERVER_ID}`,
    { method: "GET" },
    fetch_caddy,
    [404],
  );

  return response.ok;
}

export async function get_caddy_listen_addresses(
  admin_url = CADDY_DEFAULT_ADMIN_URL,
  fetch_caddy: Caddy_fetch = fetch,
) {
  const response = await request_caddy(
    admin_url,
    `/id/${CADDY_SERVER_ID}/listen`,
    { method: "GET" },
    fetch_caddy,
    [404],
  );

  if (!response.ok) {
    return null;
  }

  const listen_addresses: unknown = await response.json();

  if (
    !Array.isArray(listen_addresses) ||
    !listen_addresses.every((address) => typeof address === "string")
  ) {
    throw new Error("Caddy returned an invalid listener configuration for Devtree.");
  }

  return listen_addresses as string[];
}

export async function register_caddy_route(
  admin_url: string,
  route: Caddy_route,
  fetch_caddy: Caddy_fetch = fetch,
) {
  const route_path = `/id/${encodeURIComponent(route["@id"])}`;

  await request_caddy(
    admin_url,
    route_path,
    { method: "DELETE" },
    fetch_caddy,
    [404],
  );
  await request_caddy(
    admin_url,
    `/id/${CADDY_SERVER_ID}/routes`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(route),
    },
    fetch_caddy,
  );
}

export async function remove_caddy_route(
  admin_url: string,
  route_id: string,
  fetch_caddy: Caddy_fetch = fetch,
) {
  await request_caddy(
    admin_url,
    `/id/${encodeURIComponent(route_id)}`,
    { method: "DELETE" },
    fetch_caddy,
    [404],
  );
}
