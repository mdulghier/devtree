import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const repo = "mdulghier/devtree";
const workflow = "npm-publish.yml";
const [channel = "stable", ...extra_args] = process.argv.slice(2);

function run(command, args, inherit = false) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
  })?.trim();
}

function gh(args) {
  return run("gh", args);
}

async function find_run(commit_sha, matches) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const runs = JSON.parse(gh(["run", "list", "--repo", repo, "--workflow", workflow,
      "--event", "workflow_dispatch", "--commit", commit_sha, "--limit", "100",
      "--json", "databaseId,displayTitle"]));
    const workflow_run = runs.find(matches);
    if (workflow_run) return workflow_run;
    await setTimeout(2000);
  }
  throw new Error("The requested Actions run has not appeared. Inspect the workflow page before retrying.");
}

function watch(workflow_run) {
  console.log(`https://github.com/${repo}/actions/runs/${workflow_run.databaseId}`);
  run("gh", ["run", "watch", String(workflow_run.databaseId), "--repo", repo, "--exit-status"], true);
}

async function dispatch(action, branch, commit_sha) {
  const request_id = randomUUID();
  console.log(`Running ${action} through GitHub Actions for ${branch} (${commit_sha.slice(0, 7)}).`);
  gh(["workflow", "run", workflow, "--repo", repo, "--ref", branch,
    "-f", `channel=${action}`, "-f", `expected_sha=${commit_sha}`, "-f", `request_id=${request_id}`]);
  const workflow_run = await find_run(commit_sha, candidate => candidate.displayTitle.includes(request_id));
  watch(workflow_run);
  return workflow_run;
}

try {
  if (channel === "--help") {
    console.log("Usage: pnpm release | pnpm release:preview\nStable: prepare changelog, verify and merge the Release Please PR, then publish through Actions.\nPreview: publish the current branch through Actions.\nRequires a clean, pushed checkout. Stable releases require main.");
    process.exit(0);
  }
  if (!["stable", "preview"].includes(channel) || extra_args.length) {
    throw new Error("Usage: node scripts/release.mjs [stable|preview]");
  }
  if (run("git", ["status", "--porcelain"])) {
    throw new Error("Commit or stash local changes before releasing.");
  }
  const branch = run("git", ["branch", "--show-current"]);
  if (!branch || (channel === "stable" && branch !== "main")) {
    throw new Error("Stable releases require main; previews require a checked-out branch.");
  }
  let commit_sha = run("git", ["rev-parse", "HEAD"]);
  const remote_sha = gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]);
  if (remote_sha !== commit_sha) {
    throw new Error(`Local ${branch} does not match GitHub. Push your commits or update your checkout first.`);
  }

  if (channel === "stable") {
    await dispatch("prepare", branch, commit_sha);
    const release_prs = JSON.parse(gh(["pr", "list", "--repo", repo, "--base", "main", "--state", "open",
      "--label", "autorelease: pending", "--json", "number,headRefName,headRefOid"]));
    if (release_prs.length > 1) throw new Error("Multiple pending release PRs found; inspect them before releasing.");
    const release_pr = release_prs[0];
    if (release_pr) {
      if (release_pr.headRefName !== "release-please--branches--main") {
        throw new Error("Pending release PR is not on the expected Release Please branch.");
      }
      console.log(`Waiting for verification of release PR #${release_pr.number}.`);
      const verification = await find_run(release_pr.headRefOid, candidate => candidate.displayTitle.startsWith("Verify "));
      watch(verification);
      // Never override branch protection, and never merge an unverified PR update.
      gh(["pr", "merge", String(release_pr.number), "--repo", repo, "--squash", "--match-head-commit", release_pr.headRefOid]);
      const merged_pr = JSON.parse(gh(["pr", "view", String(release_pr.number), "--repo", repo, "--json", "state,mergeCommit"]));
      if (merged_pr.state !== "MERGED" || !merged_pr.mergeCommit?.oid) {
        throw new Error("Release PR has not merged. Repository protections or a merge queue may require attention.");
      }
      commit_sha = merged_pr.mergeCommit.oid;
      console.log(`Release PR merged. Publishing commit ${commit_sha.slice(0, 7)}.`);
    } else {
      console.log("No open release PR. Actions will check whether main contains an unpublished prepared release.");
    }
  }

  await dispatch(channel, branch, commit_sha);
  console.log(`${channel} publication completed successfully.`);
  if (channel === "stable") console.log("Update your local main with git pull --ff-only to include the release commit.");
} catch (error) {
  console.error(error.message);
  console.error(`Inspect runs before retrying: https://github.com/${repo}/actions/workflows/${workflow}`);
  process.exitCode = 1;
}
