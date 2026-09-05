import { cancel, confirm, isCancel, text } from "@clack/prompts";

import { validate_public_hostname, slugify } from "./hostname.ts";
import { command_exists } from "./process.ts";
import { resolve_tailscale } from "./tailscale.ts";

const setup_cancelled = Symbol("setup cancelled");

type Setup_input = {
  ask: (question: string) => Promise<string>;
  log: (message: string) => void;
};

async function ask_with_clack(question: string) {
  const default_match = question.match(/^(.*) \[([^\]]+)\]: $/u);
  const answer = await text({
    message: default_match?.[1] ?? question.replace(/: $/u, ""),
    initialValue: default_match?.[2],
  });

  if (isCancel(answer)) {
    throw setup_cancelled;
  }

  return answer;
}

async function ask_with_default(
  dependencies: Setup_input,
  question: string,
  default_value?: string,
) {
  const suffix = default_value ? ` [${default_value}]` : "";
  const answer = (await dependencies.ask(`${question}${suffix}: `)).trim();
  return answer || default_value || "";
}

async function ask_required_hostname(
  dependencies: Setup_input,
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

async function ask_machine_name(dependencies: Setup_input, default_value?: string) {
  while (true) {
    const answer = await ask_with_default(dependencies, "Machine namespace", default_value);
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

// Project setup deliberately plans every file before applying any changes.
export async function run_interactive_setup(
  start_dir = process.cwd(),
  session_args: string[] = [],
) {
  const { intro, note, outro, select } = await import("@clack/prompts");
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { detect_setup_project, plan_setup_files, preview_setup_url } =
    await import("./setup-project.ts");
  const { install_mise_adapter, get_mise_adapter_path } = await import("./mise.ts");
  const { ensure_local_config_ignored, resolve_devtree_local_config_path } =
    await import("./yaml-config-paths.ts");
  const { load_devtree_config } = await import("./config.ts");
  const { resolve_session_instance, parse_session_options } = await import("./session-options.ts");
  const { run_command_inherit_async } = await import("./process.ts");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Guided setup needs an interactive terminal. Run devtree setup --interactive in your terminal; use plain devtree setup for automation.",
    );
  const initial_session_options = parse_session_options(session_args);
  if (initial_session_options.passthrough_args.length)
    throw new Error("Arguments after -- are only supported by dev and exec.");
  const cancelled = setup_cancelled;
  const unwrap = <T>(answer: T | symbol): T => {
    if (isCancel(answer)) throw cancelled;
    return answer as T;
  };
  async function choose<T extends string>(
    message: string,
    values: Array<{ value: T; label: string }>,
    initial: T,
  ): Promise<T> {
    return unwrap(await select<string>({ message, options: values, initialValue: initial })) as T;
  }
  async function ask_value(message: string, initial = "", required = true) {
    return unwrap(
      await text({
        message,
        initialValue: initial,
        validate: (value) => (required && !value?.trim() ? "A value is required." : undefined),
      }),
    ).trim();
  }
  async function agree(message: string, initial = false) {
    return unwrap(await confirm({ message, initialValue: initial }));
  }
  const completed: string[] = [];
  try {
    const project = await detect_setup_project(start_dir);
    let choices = project.choices;
    intro("Devtree project setup");
    note(
      [
        `Project: ${project.repo_root}`,
        `Detected: ${choices.package_manager}, ${choices.runner}, ${choices.workflow}, ${choices.provider}`,
        `Configuration: ${project.loaded_config?.config_path ?? "new"}`,
        `Mise tasks: ${Object.keys(project.mise_config.tasks ?? {}).join(", ") || "none"}`,
        `Dependencies: ${project.loaded_config?.config.dependencies?.map((entry) => entry.name).join(", ") || "none"}`,
      ].join("\n"),
      "Detected settings — you can change these below",
    );

    let files: ReturnType<typeof plan_setup_files> = [];
    let installation: string[] = [];
    let machine_installations: string[][] = [];
    let session_options = [...session_args];
    while (true) {
      choices = { ...choices };
      choices.project_name = await ask_value("Project name", choices.project_name);
      choices.package_manager = await choose(
        "Package manager",
        ["pnpm", "npm", "yarn", "bun"].map((value) => ({
          value: value as typeof choices.package_manager,
          label: value,
        })),
        choices.package_manager,
      );
      choices.workflow = await choose(
        "Run development with",
        [
          { value: "scripts", label: "Package scripts" },
          { value: "mise", label: "mise tasks and shell environment" },
        ],
        choices.workflow,
      );
      choices.runner = await choose(
        "Server",
        [
          { value: "vite", label: "Vite" },
          { value: "vite-plus", label: "VitePlus" },
        ],
        choices.runner,
      );
      if (choices.workflow === "mise") {
        const tasks = Object.entries(project.mise_config.tasks ?? {}).filter(
          ([, task]) => !/\bdevtree\b/u.test(String(typeof task === "string" ? task : task.run)),
        );
        const selection = await choose(
          "Server task (must accept Vite flags)",
          [
            ...tasks.map(([name]) => ({ value: name, label: name })),
            { value: "__new__", label: "Create a server task" },
          ],
          tasks.some(([name]) => name === choices.task) ? choices.task : "__new__",
        );
        choices.task =
          selection === "__new__" ? await ask_value("Server task name", choices.task) : selection;
      }
      choices.access = await choose(
        "Who should be able to open the application URL?",
        [
          { value: "local", label: "This computer" },
          { value: "tailscale", label: "Devices on my Tailscale network" },
        ],
        choices.access,
      );
      if (choices.access === "tailscale") {
        choices.routing_provider = "caddy";
        const tailscale = resolve_tailscale({
          project_name: choices.project_name,
          env: { provider: choices.provider, entries: () => [] },
          tailscale: { enabled: true, mode: "proxy" },
        });
        const prompt_dependencies = { log: console.log, ask: ask_with_clack };
        choices.base_domain = await ask_required_hostname(
          prompt_dependencies,
          "Shared development domain",
          choices.base_domain || undefined,
        );
        choices.machine_name = await ask_machine_name(
          prompt_dependencies,
          choices.machine_name || slugify(tailscale.host?.split(".")[0] ?? "") || undefined,
        );
        note(
          `Wildcard DNS: *.${choices.machine_name}.${choices.base_domain} → ${tailscale.ipv4 ?? "your Tailscale IPv4 address after login"}\nCaddy will listen on the shared port. Tailscale Serve will forward that port.`,
          "Tailscale access",
        );
      } else {
        choices.routing_provider = await choose(
          "Local routing provider",
          [
            { value: "portless", label: "Portless" },
            { value: "caddy", label: "Caddy" },
          ],
          choices.routing_provider,
        );
        choices.hostname_suffix = await ask_value(
          "Custom hostname suffix (leave empty for .localhost)",
          choices.hostname_suffix,
          false,
        );
        if (choices.hostname_suffix)
          validate_public_hostname(`app.${choices.hostname_suffix}`, "Hostname suffix");
      }
      const port = Number(await ask_value("Routing port", String(choices.port)));
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Routing port must be between 1 and 65535.");
      choices.port = port;
      choices.provider = await choose(
        "Environment provider",
        [
          { value: "dotenv", label: "dotenv — maintain an env file" },
          { value: "process", label: "process — pass values without writing env files" },
          { value: "varlock", label: "Varlock — env file, validation and command wrapper" },
        ],
        project.loaded_config?.config.env.provider ??
          (choices.workflow === "mise" ? "process" : choices.provider),
      );
      while (
        await agree(
          choices.managed_values.length
            ? "Add another managed environment value?"
            : "Add a managed environment value? Existing values are preserved.",
        )
      ) {
        const key = await ask_value("Environment variable name");
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
          throw new Error("Use a shell-compatible environment variable name.");
        const source = await choose(
          "Value",
          [
            { value: "url", label: "This session's public URL" },
            { value: "literal", label: "A value I provide" },
          ],
          "url",
        );
        choices.managed_values.push({
          key,
          source,
          value:
            source === "literal"
              ? await ask_value("Value (saved in project configuration)", "", false)
              : "",
        });
      }
      const dependency_choice = await choose(
        "Dependency definitions",
        [
          { value: "keep", label: "Keep existing definitions" },
          { value: "none", label: "No dependencies" },
          { value: "compose", label: "Use a Docker Compose file" },
          { value: "command", label: "Define dependency commands" },
        ],
        project.loaded_config?.config.dependencies?.length ? "keep" : "none",
      );
      if (dependency_choice === "none") choices.dependencies = [];
      if (dependency_choice === "keep") choices.dependencies = undefined;
      if (dependency_choice === "compose") {
        const file_path = await ask_value(
          "Compose file",
          ["compose.yml", "compose.yaml", "docker-compose.yml"].find((name) =>
            existsSync(resolve(project.repo_root, name)),
          ) ?? "compose.yml",
        );
        if (!existsSync(resolve(project.repo_root, file_path)))
          throw new Error(`Compose file ${file_path} does not exist.`);
        choices.dependencies = [
          { kind: "compose", name: await ask_value("Dependency name", "services"), file_path },
        ];
      }
      if (dependency_choice === "command") {
        const name = await ask_value("Dependency name");
        const start = await ask_value("Start command (runs in the project shell)");
        const stop = await ask_value("Stop command (optional)", "", false);
        choices.dependencies = [
          {
            kind: "command",
            name,
            start: { command: ["sh", "-c", start] },
            ...(stop ? { stop: { command: ["sh", "-c", stop] as [string, ...string[]] } } : {}),
          },
        ];
      }
      const { list_registered_dependency_owners } = await import("./registry.ts");
      const owners = list_registered_dependency_owners(choices.project_name);
      if (
        !initial_session_options.dependency_owner &&
        !initial_session_options.own_dependencies &&
        owners.length &&
        ((choices.dependencies ?? project.loaded_config?.config.dependencies)?.length ?? 0) > 0
      ) {
        const owner = await choose(
          "Dependency stack for this checkout",
          [
            { value: "__self__", label: "Own a stack for this session" },
            ...owners.map((name) => ({ value: name, label: `Reuse ${name}` })),
          ],
          "__self__",
        );
        session_options = [...session_args, ...(owner === "__self__" ? ["-d"] : ["--deps", owner])];
      }
      files = plan_setup_files(project, choices);
      const needed_packages = [
        choices.runner,
        ...(choices.routing_provider === "portless" ? ["portless"] : []),
        ...(choices.provider === "varlock" ? ["varlock", "@varlock/vite-integration"] : []),
      ];
      installation = needed_packages.filter((name) => !project.packages[name]);
      const machine_tools = [
        ...(choices.workflow === "mise" ? ["mise"] : []),
        ...(choices.routing_provider === "caddy" ? ["caddy"] : []),
        ...(choices.access === "tailscale" ? ["tailscale"] : []),
        ...((choices.dependencies ?? project.loaded_config?.config.dependencies)?.some(
          (entry) => entry.kind === "compose",
        )
          ? ["docker"]
          : []),
      ];
      machine_installations = command_exists("brew")
        ? machine_tools
            .filter((name) => !command_exists(name))
            .map((name) => [
              "brew",
              "install",
              ...(name === "tailscale" || name === "docker" ? ["--cask"] : []),
              name,
            ])
        : [];
      const hooks = Object.entries(project.loaded_config?.config.hooks ?? {}).flatMap(
        ([name, commands]) =>
          (commands ?? []).map((command) => `${name}: ${command.command.join(" ")}`),
      );
      note(
        [
          `URL preview: ${preview_setup_url(project, choices)}`,
          ...files.map((file) => `${file.before ? "Edit" : "Create"} ${file.path}`),
          ...(installation.length
            ? [`Install development packages: ${installation.join(", ")}`]
            : []),
          ...machine_installations.map((command) => command.join(" ")),
          ...machine_tools
            .filter((name) => !command_exists(name) && !machine_installations.length)
            .map((name) => `Install ${name} manually before verification.`),
          ...(choices.workflow === "mise"
            ? [
                `Copy and register adapter: ${get_mise_adapter_path()}`,
                "Enable mise shell activation if it is not already enabled.",
              ]
            : []),
          ...(choices.access === "tailscale"
            ? [
                "Ignore the machine configuration in Git.",
                "Verification may start Caddy and configure Tailscale Serve. DNS and login remain manual.",
              ]
            : ["Verification may start the local routing proxy."]),
          ...hooks,
          `Dependency definitions: ${(choices.dependencies ?? project.loaded_config?.config.dependencies ?? []).map((entry) => entry.name).join(", ") || "none"}`,
          `Dependency stack: ${session_options.join(" ") || "checkout selection or default"}`,
          "Dependencies and hooks run only if selected after configuration is saved.",
        ].join("\n"),
        "Review setup",
      );
      if (await agree("Show the complete proposed file contents?"))
        for (const file of files) note(file.after, file.path);
      const review = await choose(
        "Apply this setup?",
        [
          { value: "apply", label: "Apply" },
          { value: "back", label: "Go back and change choices" },
          { value: "cancel", label: "Cancel" },
        ],
        "apply",
      );
      if (review === "cancel") throw cancelled;
      if (review === "apply") break;
    }
    for (const file of files) {
      const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
      if (current !== file.before)
        throw new Error(`${file.path} changed during setup. Rerun the guide before applying it.`);
    }
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.after);
      completed.push(file.path);
    }
    if (choices.access === "tailscale")
      ensure_local_config_ignored(
        project.repo_root,
        resolve_devtree_local_config_path(project.repo_root),
      );
    const run = async (parts: string[]) => {
      const status = await run_command_inherit_async(parts[0], parts.slice(1), {
        cwd: project.repo_root,
      });
      if (status !== 0) throw new Error(`${parts.join(" ")} exited with status ${status}.`);
    };
    for (const command of machine_installations) {
      await run(command);
      completed.push(command.join(" "));
    }
    if (installation.length) {
      await run([
        choices.package_manager,
        choices.package_manager === "npm" ? "install" : "add",
        "-D",
        ...installation,
      ]);
      completed.push(`Installed ${installation.join(", ")}`);
    }
    if (choices.workflow === "mise") {
      install_mise_adapter();
      completed.push(`Registered ${get_mise_adapter_path()}`);
      note(
        "Enable mise in your shell using its getting-started guide, then run `mise trust` in this project. The adapter refreshes the session values on each mise environment activation.",
        "Shell environment",
      );
    }
    const vite_configs = ["vite.config.ts", "vite.config.js", "vite.config.mts"].filter((name) =>
      existsSync(resolve(project.repo_root, name)),
    );
    const old_plugin = vite_configs.some((name) =>
      /devtree\/vite/u.test(readFileSync(resolve(project.repo_root, name), "utf8")),
    );
    if (old_plugin || choices.provider === "varlock") {
      note(
        'Remove any devtree/vite import and devtree_vite_plugins call. For Varlock, add:\nimport { varlockVitePlugin } from "@varlock/vite-integration";\nplugins: [varlockVitePlugin({ ssrInjectMode: "init-only" })]\nVarlock also needs your application’s .env.schema.',
        "Vite migration",
      );
      if (old_plugin)
        throw new Error(
          "Configuration saved. Remove the obsolete Vite plugin before starting the application.",
        );
    }
    const loaded_config = await load_devtree_config(project.repo_root);
    const instance = (await resolve_session_instance(
      loaded_config,
      parse_session_options(session_options),
    ))!;
    note(`Session: ${instance.session_name}\nURL: ${instance.public_url}`, "Configuration saved");
    if (
      choices.access === "tailscale" &&
      !(await agree("Tailscale is signed in and wildcard DNS is configured. Verify now?"))
    ) {
      outro(
        "Configuration saved. Finish Tailscale login and DNS, then rerun devtree setup --interactive.",
      );
      return;
    }
    const cli_command = [process.execPath, ...process.execArgv, process.argv[1]];
    await run([...cli_command, "doctor", "--fix"]);
    if (
      instance.dependencies.owns &&
      (await agree("Start dependencies and run the configured setup and migration hooks?"))
    ) {
      await run([...cli_command, "setup", ...session_options]);
      completed.push("Started dependencies and completed configured setup hooks");
    }
    const start_command =
      choices.workflow === "mise"
        ? "mise exec -- devtree dev"
        : `${choices.package_manager} exec devtree dev`;
    if (!(await agree("Start the development server and verify its public URL?"))) {
      outro(
        `Session ${instance.session_name} is ready to start. URL: ${instance.public_url}\nRun: ${start_command}\nApplication has not been verified.`,
      );
      return;
    }
    let server_pid: number | undefined;
    let exited = false;
    const server = run_command_inherit_async(cli_command[0], [...cli_command.slice(1), "dev"], {
      cwd: project.repo_root,
      on_spawn: (pid) => {
        server_pid = pid;
      },
    }).finally(() => {
      exited = true;
    });
    let verified = false;
    for (let attempt = 0; attempt < 60 && !exited; attempt += 1) {
      try {
        const response = await fetch(instance.public_url, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok && !exited) {
          verified = true;
          break;
        }
      } catch {
        /* The server or route may still be starting. */
      }
      await new Promise((resolve_wait) => setTimeout(resolve_wait, 250));
    }
    if (!verified) {
      if (server_pid && !exited) process.kill(server_pid, "SIGTERM");
      await server;
      throw new Error(
        `Configuration saved, but ${instance.public_url} did not respond successfully. Check the server output and rerun ${start_command}.`,
      );
    }
    outro(
      `Application verified at ${instance.public_url}. Session: ${instance.session_name}. Press Ctrl-C to stop; the session will remain saved.`,
    );
    process.exitCode = await server;
  } catch (error) {
    if (error === cancelled) {
      cancel(
        completed.length
          ? `Setup cancelled after applying:\n${completed.join("\n")}\nResume with devtree setup --interactive.`
          : "Setup cancelled. No files were changed.",
      );
      return;
    }
    if (completed.length)
      console.error(
        `Completed:\n${completed.join("\n")}\nResume with devtree setup --interactive.`,
      );
    throw error;
  }
}
