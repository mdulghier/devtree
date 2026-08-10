import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";

export type Command_result = {
  status: number;
  stdout: string;
  stderr: string;
};

export type Run_command_options = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allow_failure?: boolean;
};

export type Logged_command_options = Run_command_options & {
  detached?: boolean;
};

export type Async_run_command_options = Run_command_options & {
  on_spawn?: (pid: number) => void;
};

export function command_exists(command: string) {
  const result = spawnSync("which", [command], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });

  return result.status === 0;
}

export function run_command_capture(
  command: string,
  args: string[],
  options?: Run_command_options,
): Command_result {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...options?.env },
  });

  if (result.error) {
    throw result.error;
  }

  const command_result = {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };

  if (!options?.allow_failure && command_result.status !== 0) {
    throw new Error(command_result.stderr || `${command} ${args.join(" ")} failed`);
  }

  return command_result;
}

export function run_command_logged(
  command: string,
  args: string[],
  log_path: string,
  options?: Logged_command_options,
): Promise<Command_result> {
  const log_file = openSync(log_path, "w");
  const child_process = spawn(command, args, {
    cwd: options?.cwd ?? process.cwd(),
    detached: options?.detached,
    env: { ...process.env, ...options?.env },
    stdio: ["ignore", log_file, log_file],
  });

  return new Promise((resolve_result, reject_result) => {
    let settled = false;

    child_process.once("error", (error) => {
      settled = true;
      closeSync(log_file);
      reject_result(error);
    });
    child_process.once("close", (status) => {
      if (settled) {
        return;
      }

      settled = true;
      closeSync(log_file);

      const command_result = {
        status: status ?? 1,
        stdout: "",
        stderr: readFileSync(log_path, "utf8").trim(),
      };

      if (!options?.allow_failure && command_result.status !== 0) {
        reject_result(
          new Error(command_result.stderr || `${command} ${args.join(" ")} failed`),
        );
        return;
      }

      resolve_result(command_result);
    });
  });
}

export function run_command_inherit(
  command: string,
  args: string[],
  options?: Run_command_options,
) {
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? process.cwd(),
    env: { ...process.env, ...options?.env },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (!options?.allow_failure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.status ?? 0;
}

export function run_command_inherit_async(
  command: string,
  args: string[],
  options?: Async_run_command_options,
) {
  const child_process = spawn(command, args, {
    cwd: options?.cwd ?? process.cwd(),
    env: { ...process.env, ...options?.env },
    stdio: "inherit",
  });

  if (child_process.pid !== undefined) {
    options?.on_spawn?.(child_process.pid);
  }

  return new Promise<number>((resolve_result, reject_result) => {
    const forwarded_signals = ["SIGINT", "SIGTERM"] as const;
    let settled = false;

    const remove_signal_handlers = () => {
      for (const signal of forwarded_signals) {
        process.off(signal, signal_handlers[signal]);
      }
    };
    const signal_handlers = {
      SIGINT: () => child_process.kill("SIGINT"),
      SIGTERM: () => child_process.kill("SIGTERM"),
    };

    for (const signal of forwarded_signals) {
      process.on(signal, signal_handlers[signal]);
    }

    child_process.once("error", (error) => {
      settled = true;
      remove_signal_handlers();
      reject_result(error);
    });
    child_process.once("exit", (status, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      remove_signal_handlers();

      if (status !== null) {
        resolve_result(status);
        return;
      }

      resolve_result(signal === "SIGINT" ? 130 : 143);
    });
  });
}
