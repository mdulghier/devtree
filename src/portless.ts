export function get_portless_alias_add_args(hostname: string, port: number) {
  return ["alias", hostname, String(port), "--force"];
}

export function get_portless_alias_remove_args(hostname: string) {
  return ["alias", "--remove", hostname];
}
