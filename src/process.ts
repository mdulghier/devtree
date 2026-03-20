import { spawnSync } from "node:child_process";

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
