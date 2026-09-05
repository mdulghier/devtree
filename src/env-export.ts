export function format_env_export(
  values: Record<string, string | undefined>,
  format: "plain" | "shell" | "json",
) {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0")) {
      throw new Error(`Cannot export invalid environment entry ${JSON.stringify(key)}.`);
    }
  }
  if (format === "json") return JSON.stringify(Object.fromEntries(entries), null, 2);
  return entries
    .map(([key, value]) =>
      format === "shell" ? `export ${key}='${value.replaceAll("'", "'\\''")}'` : `${key}=${value}`,
    )
    .join("\n");
}
