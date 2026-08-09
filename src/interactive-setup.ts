import { createInterface } from "node:readline/promises";

import type { Loaded_devtree_config } from "./config.ts";
import { validate_public_hostname, slugify } from "./hostname.ts";
import { command_exists } from "./process.ts";
import { resolve_routing } from "./routing.ts";
import { resolve_tailscale, type Resolved_tailscale } from "./tailscale.ts";
import {
  write_interactive_yaml_setup,
  type Interactive_yaml_setup_values,
} from "./yaml-config-writer.ts";

export type Interactive_setup_dependencies = {
  ask: (question: string) => Promise<string>;
  log: (message: string) => void;
  command_exists: (command: string) => boolean;
  resolve_tailscale: (loaded_config: Loaded_devtree_config) => Resolved_tailscale;
  write_config: (
    repo_root: string,
    values: Interactive_yaml_setup_values,
  ) => { project_path: string; local_path: string };
};

function get_default_dependencies(
  ask: Interactive_setup_dependencies["ask"],
): Interactive_setup_dependencies {
  return {
    ask,
    log: console.log,
    command_exists,
    resolve_tailscale: (loaded_config) =>
      resolve_tailscale({
        ...loaded_config.config,
        tailscale: {
          ...loaded_config.config.tailscale,
          enabled: true,
          mode: "proxy",
        },
      }),
    write_config: write_interactive_yaml_setup,
  };
}

async function ask_with_default(
  dependencies: Interactive_setup_dependencies,
  question: string,
  default_value?: string,
) {
  const suffix = default_value ? ` [${default_value}]` : "";
  const answer = (await dependencies.ask(`${question}${suffix}: `)).trim();
  return answer || default_value || "";
}

async function ask_required_hostname(
  dependencies: Interactive_setup_dependencies,
  question: string,
  default_value?: string,
) {
  while (true) {
    const answer = (await ask_with_default(dependencies, question, default_value))
      .replace(/\.$/u, "")
      .toLowerCase();

    try {
      validate_public_hostname(answer, question);
      return answer;
    } catch (error) {
      dependencies.log(error instanceof Error ? error.message : String(error));
    }
  }
}

async function ask_machine_name(
  dependencies: Interactive_setup_dependencies,
  default_value?: string,
) {
  while (true) {
    const answer = await ask_with_default(
      dependencies,
      "Machine namespace",
      default_value,
    );
    const machine_name = slugify(answer);

    if (!machine_name) {
      dependencies.log("Machine namespace must contain a letter or number.");
      continue;
    }

    try {
      validate_public_hostname(`${machine_name}.example`, "Machine namespace");
      return machine_name;
    } catch (error) {
      dependencies.log(error instanceof Error ? error.message : String(error));
    }
  }
}

async function ask_port(
  dependencies: Interactive_setup_dependencies,
  default_port: number,
) {
  while (true) {
    const answer = await ask_with_default(
      dependencies,
      "Shared Caddy and Tailscale port",
      String(default_port),
    );
    const port = Number(answer);

    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }

    dependencies.log("Port must be an integer from 1 to 65535.");
  }
}

async function ask_confirmation(
  dependencies: Interactive_setup_dependencies,
  question: string,
) {
  while (true) {
    const answer = (await dependencies.ask(`${question} [Y/n]: `)).trim().toLowerCase();

    if (!answer || answer === "y" || answer === "yes") {
      return true;
    }

    if (answer === "n" || answer === "no") {
      return false;
    }

    dependencies.log('Enter "yes" or "no".');
  }
}

async function run_interactive_setup_with_dependencies(
  loaded_config: Loaded_devtree_config,
  dependencies: Interactive_setup_dependencies,
) {
  dependencies.log("Devtree interactive Tailscale setup");
  dependencies.log("");

  if (!dependencies.command_exists("caddy")) {
    throw new Error(
      "Caddy is required for Tailscale proxy routing, but the `caddy` command is not available on PATH. Install Caddy and rerun `devtree setup --interactive`.",
    );
  }

  const tailscale = dependencies.resolve_tailscale(loaded_config);

  if (!tailscale.cli_available) {
    throw new Error(
      "Tailscale is required for interactive proxy setup, but the `tailscale` command is not available on PATH. Install Tailscale and rerun `devtree setup --interactive`.",
    );
  }

  if (!tailscale.connected || !tailscale.ipv4 || !tailscale.node_id) {
    throw new Error(
      tailscale.error ??
        "Tailscale is not connected. Start Tailscale, sign in, and rerun `devtree setup --interactive`.",
    );
  }

  dependencies.log(`✓ Caddy available`);
  dependencies.log(
    `✓ Tailscale connected${tailscale.host ? ` as ${tailscale.host}` : ""} (${tailscale.ipv4})`,
  );
  dependencies.log("");

  const yaml_config = loaded_config.yaml_config?.merged;
  const detected_machine_name = slugify(tailscale.host?.split(".")[0] ?? "");
  const base_domain = await ask_required_hostname(
    dependencies,
    "Shared development domain",
    yaml_config?.routing?.base_domain,
  );
  const machine_name = await ask_machine_name(
    dependencies,
    yaml_config?.routing?.machine_name ?? (detected_machine_name || undefined),
  );
  const port = await ask_port(
    dependencies,
    yaml_config?.routing?.port ?? resolve_routing(loaded_config.config).port,
  );
  const hostname_suffix = `${machine_name}.${base_domain}`;

  dependencies.log("");
  dependencies.log(`Application hostnames: *.${hostname_suffix}`);
  dependencies.log(`Required wildcard DNS: *.${hostname_suffix} -> ${tailscale.ipv4}`);
  dependencies.log(`Shared proxy port: ${port}`);
  dependencies.log("");

  if (!(await ask_confirmation(dependencies, "Write this configuration?"))) {
    dependencies.log("Setup cancelled. No files were changed.");
    return { configured: false as const };
  }

  const written_paths = dependencies.write_config(loaded_config.repo_root, {
    base_domain,
    machine_name,
    port,
  });

  dependencies.log("");
  dependencies.log(`✓ Project configuration: ${written_paths.project_path}`);
  dependencies.log(`✓ Local machine configuration: ${written_paths.local_path}`);
  dependencies.log(
    `Configure *.${hostname_suffix} to resolve to ${tailscale.ipv4} before opening the application from another tailnet machine.`,
  );

  const continue_answer = (
    await dependencies.ask(
      'Configure DNS now, then press Enter to verify and continue. Type "later" to stop after saving: ',
    )
  )
    .trim()
    .toLowerCase();
  const continue_setup = continue_answer !== "later";

  if (!continue_setup) {
    dependencies.log(
      "Configuration saved. After DNS is ready, run `devtree setup` to verify it and finish project setup.",
    );
  }

  return {
    configured: true as const,
    continue_setup,
    hostname_suffix,
    tailscale_ipv4: tailscale.ipv4,
    ...written_paths,
  };
}

export async function run_interactive_setup(
  loaded_config: Loaded_devtree_config,
  provided_dependencies?: Interactive_setup_dependencies,
) {
  if (provided_dependencies) {
    return run_interactive_setup_with_dependencies(
      loaded_config,
      provided_dependencies,
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await run_interactive_setup_with_dependencies(
      loaded_config,
      get_default_dependencies((question) => readline.question(question)),
    );
  } finally {
    readline.close();
  }
}
