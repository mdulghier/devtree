import { cpSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { command_exists, run_command_capture } from "./process.ts";

export function get_mise_adapter_path() {
  return resolve(homedir(), ".devtree", "mise", "devtree");
}

export function install_mise_adapter() {
  if (!command_exists("mise"))
    throw new Error(
      "mise is not installed. Install it from https://mise.jdx.dev/getting-started.html, then rerun devtree mise install.",
    );
  const adapter_path = get_mise_adapter_path();
  const data_root =
    process.env.MISE_DATA_DIR ??
    resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "mise");
  const registration_path = resolve(data_root, "plugins", "devtree");
  let registered = false;
  try {
    const registration = lstatSync(registration_path);
    registered =
      registration.isSymbolicLink() &&
      resolve(dirname(registration_path), readlinkSync(registration_path)) === adapter_path;
    if (!registered)
      throw new Error(
        `mise plugin "devtree" already points to an unrelated plugin at ${registration_path}. Resolve that conflict before installing this adapter.`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(adapter_path, { recursive: true, mode: 0o700 });
  cpSync(resolve(import.meta.dirname, "..", "mise"), adapter_path, { recursive: true });
  if (!registered) run_command_capture("mise", ["plugins", "link", "devtree", adapter_path]);
  console.log(`Installed Devtree mise adapter at ${adapter_path}.`);
  return adapter_path;
}
