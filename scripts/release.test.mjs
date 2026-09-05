import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const release_script = resolve(import.meta.dirname, "release.mjs");

function fixture(t, branch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "devtree-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo_dir = join(dir, "repo");
  const bin_dir = join(dir, "bin");
  mkdirSync(repo_dir);
  mkdirSync(bin_dir);
  const git = (...args) => execFileSync("git", args, { cwd: repo_dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", branch);
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.test");
  writeFileSync(join(repo_dir, "package.json"), JSON.stringify({ version: "0.5.0" }));
  git("add", ".");
  git("commit", "-m", "fixture");
  const commit_sha = git("rev-parse", "HEAD");
  const call_log = join(dir, "calls.jsonl");
  writeFileSync(join(bin_dir, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
const calls = readFileSync(process.env.CALL_LOG, 'utf8').trim().split('\\n').map(JSON.parse);
const last_dispatch = calls.filter(call => call[0] === 'workflow').at(-1);
if (args[0] === 'api') console.log(process.env.REMOTE_SHA);
else if (args[0] === 'workflow' && args[1] === 'run') {}
else if (args[0] === 'run' && args[1] === 'list') {
  const commit = args[args.indexOf('--commit') + 1];
  if (commit === 'pr-head') console.log(JSON.stringify([{ databaseId: 2, displayTitle: 'Verify release-please--branches--main' }]));
  else {
    const request_id = last_dispatch.find(arg => arg.startsWith('request_id=')).slice(11);
    const channel = last_dispatch.find(arg => arg.startsWith('channel=')).slice(8);
    console.log(JSON.stringify([{ databaseId: channel === 'prepare' ? 1 : 3, displayTitle: channel + ' ' + request_id }]));
  }
} else if (args[0] === 'run' && args[1] === 'watch') {
  if (args[2] === process.env.FAIL_RUN) process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: 7, headRefName: 'release-please--branches--main', headRefOid: 'pr-head' }]));
} else if (args[0] === 'pr' && args[1] === 'merge') {}
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'merged-head' } }));
else process.exit(2);
`, { mode: 0o755 });
  return {
    repo_dir, commit_sha,
    run: (channel, remote_sha = commit_sha, fail_run = "") => spawnSync(process.execPath, [release_script, channel], {
      cwd: repo_dir, encoding: "utf8",
      env: { ...process.env, PATH: `${bin_dir}:${process.env.PATH}`, CALL_LOG: call_log, REMOTE_SHA: remote_sha, FAIL_RUN: fail_run },
    }),
    calls: () => readFileSync(call_log, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("stable prepares, verifies, merges the checked PR, and publishes its merge commit", t => {
  const context = fixture(t);
  const result = context.run("stable");
  assert.equal(result.status, 0, result.stderr);
  const calls = context.calls();
  const dispatches = calls.filter(args => args[0] === "workflow");
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches[0].includes("channel=prepare"));
  assert.ok(dispatches[0].includes(`expected_sha=${context.commit_sha}`));
  assert.ok(dispatches[1].includes("channel=stable"));
  assert.ok(dispatches[1].includes("expected_sha=merged-head"));
  assert.deepEqual(calls.find(args => args[0] === "pr" && args[1] === "merge"),
    ["pr", "merge", "7", "--repo", "mdulghier/devtree", "--squash", "--match-head-commit", "pr-head"]);
  assert.ok(calls.findIndex(args => args[1] === "watch" && args[2] === "2") < calls.findIndex(args => args[1] === "merge"));
});

test("preview publishes the exact branch commit and waits without creating a release PR", t => {
  const context = fixture(t, "feature/preview");
  const result = context.run("preview");
  assert.equal(result.status, 0, result.stderr);
  const calls = context.calls();
  const dispatches = calls.filter(args => args[0] === "workflow");
  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0].includes("channel=preview"));
  assert.ok(dispatches[0].includes(`expected_sha=${context.commit_sha}`));
  assert.ok(dispatches[0].includes("feature/preview"));
  assert.equal(calls.some(args => args[0] === "pr"), false);
  assert.ok(calls.some(args => args[1] === "watch"));
});

test("failed release PR verification stops before merge or publication", t => {
  const context = fixture(t);
  const result = context.run("stable", context.commit_sha, "2");
  assert.equal(result.status, 1);
  const calls = context.calls();
  assert.equal(calls.some(args => args[1] === "merge"), false);
  assert.equal(calls.some(args => args.includes("channel=stable")), false);
});

test("a failed publish run makes the local command fail", t => {
  const context = fixture(t);
  assert.equal(context.run("preview", context.commit_sha, "3").status, 1);
});

test("does not dispatch an unpushed commit", t => {
  const context = fixture(t);
  const result = context.run("stable", "a".repeat(40));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match GitHub/);
  assert.equal(context.calls().some(args => args[0] === "workflow"), false);
});

test("rejects a dirty checkout and stable releases from feature branches", t => {
  const context = fixture(t, "feature/test");
  assert.match(context.run("stable").stderr, /Stable releases require main/);
  writeFileSync(join(context.repo_dir, "uncommitted.txt"), "change");
  assert.match(context.run("preview").stderr, /Commit or stash/);
});
