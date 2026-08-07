export const PORTLESS_EXACT_HOSTNAME_FLAG = "--hostname";

export function portless_supports_exact_hostname(help_text: string) {
  return help_text.includes(PORTLESS_EXACT_HOSTNAME_FLAG);
}

export function get_portless_compatibility_error(help_text: string) {
  if (portless_supports_exact_hostname(help_text)) {
    return null;
  }

  return (
    "The installed Portless CLI does not support Devtree's exact-hostname contract " +
    "(`portless run --hostname <hostname>`). Install a Portless version that accepts a complete " +
    "hostname without adding a worktree prefix, or remove portless.hostname."
  );
}
