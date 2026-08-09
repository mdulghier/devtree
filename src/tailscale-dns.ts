import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Tailscale_dns_resolution = "tailnet" | "local-hosts";

export type Tailscale_hostname_lookup = (
  hostname: string,
) => Promise<string[]>;

const default_lookup: Tailscale_hostname_lookup = async (hostname) => {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map(({ address }) => address);
};

function is_loopback(address: string) {
  return address === "::1" || address.startsWith("127.");
}

export async function validate_tailscale_hostname(
  hostname: string,
  tailscale_ipv4: string,
  resolve_hostname: Tailscale_hostname_lookup = default_lookup,
): Promise<Tailscale_dns_resolution> {
  if (isIP(tailscale_ipv4) !== 4) {
    throw new Error(
      `Cannot validate ${hostname} because Tailscale did not provide a valid IPv4 address.`,
    );
  }

  let addresses: string[];

  try {
    addresses = await resolve_hostname(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Tailscale application hostname ${hostname} does not resolve. ` +
        `Point its wildcard DNS record to ${tailscale_ipv4}, or add the entries printed by \`pnpm devtree hosts\`. ${message}`,
    );
  }

  if (addresses.includes(tailscale_ipv4)) {
    return "tailnet";
  }

  if (addresses.length > 0 && addresses.every(is_loopback)) {
    return "local-hosts";
  }

  const resolved_addresses = addresses.length > 0 ? addresses.join(", ") : "no addresses";

  throw new Error(
    `Tailscale application hostname ${hostname} resolves to ${resolved_addresses}, ` +
      `but this machine's Tailscale IPv4 address is ${tailscale_ipv4}. ` +
      "Update the wildcard DNS record or the remote hosts-file entry; Devtree did not change DNS.",
  );
}
