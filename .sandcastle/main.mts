import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeCode, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { isLimitError, parseResetWaitMs } from "./limit.mts";

// Sandcastle supervisor for the Portuni `ready-for-agent` backlog. Launch via
// ./.sandcastle/start-loop.sh (tmux + caffeinate). run() executes in a
// limit-survival loop: a Claude subscription usage limit aborts the run, the
// supervisor waits for the reset and continues on the same branch.

// One batch of issues = one branch and one PR. The branch name derives from
// the supervisor start date; a same-day restart resumes the branch.
// Override with SANDCASTLE_BRANCH=... when a batch spans several days.
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const BRANCH = process.env.SANDCASTLE_BRANCH ?? `ralph/backlog-${today}`;
const MODEL = process.env.SANDCASTLE_MODEL ?? "claude-sonnet-5";
const MAX_ITERATIONS = Number(process.env.SANDCASTLE_MAX_ITERATIONS ?? 10);
const MAX_RUNS = Number(process.env.SANDCASTLE_MAX_RUNS ?? 24);
// Must match the completion signal in prompt.md.
const COMPLETE = "<promise>COMPLETE</promise>";
const LIMIT_FALLBACK_MS = 30 * 60_000;
// Exponential backoff for non-limit failures, ~5 h in total.
const FAILURE_BACKOFFS_MIN = [5, 10, 20, 40, 80, 160];

// Git refuses to check out one branch in two worktrees. The agent gets BRANCH
// in its own worktree under .sandcastle/worktrees/, so the main working tree
// must not sit on it.
const checkedOut = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();
if (checkedOut === BRANCH) {
  console.error(
    `The main working tree has '${BRANCH}' checked out, which the agent worktree needs.\n` +
      `Switch elsewhere (e.g. 'git checkout main') and start again.`,
  );
  process.exit(1);
}

function log(message: string): void {
  console.log(`[loop ${new Date().toISOString()}] ${message}`);
}

// Progress is measured by movement of the target branch ref, not by run()'s
// return value.
function branchTip(): string {
  try {
    return execFileSync("git", ["rev-parse", BRANCH], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

let otherFailures = 0;
let limitWaits = 0;

for (let runNumber = 1; runNumber <= MAX_RUNS; runNumber++) {
  log(`Run ${runNumber}/${MAX_RUNS} starting (model=${MODEL}, maxIterations=${MAX_ITERATIONS}, branch=${BRANCH}).`);

  let stdout = "";
  let failed: Error | null = null;
  let completed = false;
  const tipBefore = branchTip();

  try {
    const result = await run({
      name: `worker-${runNumber}`,
      // Isolated Docker container over a bind-mounted worktree. Credentials
      // (GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) come from .sandcastle/.env.
      sandbox: docker(),
      // Claude Code in subscription mode, auth via CLAUDE_CODE_OAUTH_TOKEN.
      agent: claudeCode(MODEL),
      promptFile: "./.sandcastle/prompt.md",
      // Narrow the issue selection, e.g. SANDCASTLE_SCOPE="only issue #84".
      promptArgs: { SCOPE: process.env.SANDCASTLE_SCOPE ?? "" },
      maxIterations: MAX_ITERATIONS,
      // Long idle timeout: the first cargo build in a fresh worktree is quiet
      // for many minutes.
      idleTimeoutSeconds: 1800,
      completionSignal: COMPLETE,
      branchStrategy: { type: "branch", branch: BRANCH },
      hooks: {
        sandbox: {
          onSandboxReady: [
            // gh auth setup-git wires GH_TOKEN into git (branch push, PR).
            { command: "gh auth setup-git" },
            // Dependencies and desktop build placeholders up front so the
            // agent does not spend iterations on them.
            { command: "npm ci" },
            { command: "npm ci --prefix apps/web" },
            { command: "npm ci --prefix sites/docs" },
            { command: "scripts/desktop-dev-placeholders.sh" },
          ],
        },
      },
    });
    stdout = result.stdout;
    completed = result.completionSignal !== undefined;
    log(`Run finished: ${result.iterations.length} iterations, ${result.commits.length} commits.`);
  } catch (e) {
    failed = e instanceof Error ? e : new Error(String(e));
    stdout = failed.message;
    log(`Run failed: ${failed.message.slice(0, 300)}`);
  }

  if (completed) {
    log("Agent reported COMPLETE, backlog empty.");
    process.exit(0);
  }

  const probe = stdout.slice(-4000);
  if (isLimitError(probe)) {
    limitWaits = branchTip() !== tipBefore ? 1 : limitWaits + 1;
    if (limitWaits > 6) {
      log("Seventh consecutive limit wait without a commit: false limit detection or a stuck state; stopping.");
      process.exit(1);
    }
    const waitMs = parseResetWaitMs(probe) ?? LIMIT_FALLBACK_MS;
    log(`Usage limit, waiting ${Math.round(waitMs / 60_000)} minutes for the reset.`);
    otherFailures = 0;
    await sleep(waitMs);
    continue;
  }

  if (failed) {
    otherFailures = branchTip() !== tipBefore ? 1 : otherFailures + 1;
    limitWaits = 0;
    if (otherFailures > FAILURE_BACKOFFS_MIN.length) {
      log("Sixth consecutive failure without branch movement: stopping, needs manual intervention.");
      process.exit(1);
    }
    const backoffMin = FAILURE_BACKOFFS_MIN[otherFailures - 1];
    log(`Non-limit failure ${otherFailures}/${FAILURE_BACKOFFS_MIN.length}, pausing ${backoffMin} minutes.`);
    await sleep(backoffMin * 60_000);
    continue;
  }

  otherFailures = 0;
  limitWaits = 0;
  log("maxIterations exhausted without COMPLETE, continuing with another run.");
}

log(`${MAX_RUNS} runs exhausted, stopping. The remaining backlog needs manual review.`);
process.exit(1);
