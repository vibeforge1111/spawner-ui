# Spawner UI Agent Ruleset

## Repo Role

`spawner-ui` owns Spark mission execution, provider dispatch, mission control,
scheduled fires, creator mission execution, local previews, and the operator UI
for the execution plane.

Canonical truth owned here:

- mission execution lifecycle after Governor authorization
- provider dispatch and completion evidence metadata
- Mission Control commands, board state, schedule execution, and creator mission
  execution records
- local preview/project serving and execution-plane health

This repo does not own:

- raw natural-language intent authority
- Telegram ingress, access prompts, or final chat composition
- Builder RouteConfidenceGateV1, AOC, identity, or durable memory truth
- CLI registry pins, installer metadata, or Spark OS compiler truth
- Harness Core schemas, Governor semantics, or readiness scoring

## Start-of-Work Protocol

1. Run `git status --short --branch`.
2. Read this file plus `docs/SPARK_HARNESS_CONTRACT_ADOPTION.md` and the
   relevant route/service doc before edits.
3. Identify whether the requested change belongs in Spawner or in Telegram,
   Builder, CLI, Harness Core, memory, voice, or a domain chip.
4. Define the smallest execution-plane behavior and stop-ship gate.
5. Add focused tests for the route, service, authority, schedule, mission
   control, or creator path being changed.
6. Keep execution APIs as capability consumers. Do not add local intent
   detectors that can bypass the Governor.
7. Run focused tests, then `npm run check` and `npm run build` for release-risk
   changes.
8. Commit one logical checkpoint with verification notes.

## One Truth Rules

- Spawner executes authorized work; it does not decide raw user intent.
- Fresh user intent is expressed through Harness Core/Governor authority passed
  in from the caller or created by a source-owned internal policy.
- Local mission state, schedule state, provider state, and board state are
  execution-plane truth, not permission to start new user-requested work.
- Lifecycle state is monotonic. Emit `mission_started` only from a real
  `dispatch_started` owner event, before any task or terminal callback; never
  emit a late start after awaiting a dispatch that may already have failed.
- Old patches, wording vetoes, pending-state helpers, and route-specific
  launch checks are migration debt until retired, demoted to evidence, bound
  behind Governor authority, or carried as explicit release blockers.
- Registry pins, provenance, and public release metadata belong to Spark CLI and
  the publishing machine. Do not advance them from this repo casually.

## Authority Rules

- Every high-agency Spawner route must require native `GovernorDecisionV1`
  authority or an explicitly documented machine-origin policy.
- Bare `TurnIntentEnvelopeVNext`, route words, mission ids, stale board state,
  pending state, or local regex must not authorize execution by themselves.
- Chat-only, denied, interrupted, degraded, stale, or owner-mismatched Governor
  decisions must block before provider dispatch or state mutation.
- Tool ledgers and completion evidence are proof records, not permission grants.
  A blocked or interrupted action cannot later be finalized as successful
  execution.
- Positive explicit actions should still work quickly once Governor authority,
  capability, owner policy, freshness, and risk requirements are satisfied.
- Schedule create/delete, creator mission create/execute, mission-control
  pause/resume/cancel, provider dispatch, PRD auto-dispatch, browser/computer
  use, publish/deploy, and public/network promotion paths are high-agency until
  proven otherwise.

## Local Operator And Workspace Rules

- Local operator Mission Control is not a login system. Loopback browser access
  to Kanban, Canvas, Trace, Result, and `/spark-live/login` must be classified
  by request origin and must not create or require `spawner_ui_session`.
- Hosted/private-preview browser access is the only path that should use
  workspace ID + UI access key + opaque session cookies.
- Do not use hosted UI auth as an execution authority layer. It is a browser
  access gate only; Harness Core/Governor authority remains the execution
  authority.
- Provider work that can write files must run in a Spark-owned workspace from
  `resolveSparkRunProjectPath()` or an equivalent workspace-root helper.
- Do not pass `process.cwd()` as a provider `workingDirectory` for generated
  missions, PRD auto-analysis, Telegram builds, or auto-dispatch. In installed
  runtimes `process.cwd()` can be the Spawner source folder, which must remain
  code/runtime truth, not a generated project workspace.
- Do not fix workspace failures by setting
  `SPARK_ALLOW_EXTERNAL_PROJECT_PATHS=1` for release or installer paths. That
  flag is only a trusted local-development escape hatch.
- If a route needs to inspect Spawner source, keep that read-only and separate
  from the provider working directory.

## Privacy Red Lines

Do not export, commit, or render into user-facing surfaces:

- secrets, tokens, env values, credentials, private keys
- raw chat ids, user ids, or account identifiers
- raw prompts when metadata is enough
- provider output bodies unless an explicit trusted-local fallback is enabled
- memory bodies or transcript bodies
- raw audio payloads
- private `spark-intelligence-systems` strategy

Prefer redacted refs, trace ids, route labels, status, provider names, mission
titles, preview URLs, and summarized completion evidence over raw payloads.

## Verification Menu

- Focused Vitest route/service tests for the changed behavior.
- Authority tests for changed execution routes.
- `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run check`
- `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run build`
- `npm run sync:check` when installed runtime sync is relevant.
- `git diff --check`.
- `git status --short --branch`.
- `spark os compile --json` after authority or release-surface changes.

Use `/usr/local/bin/node` first on this Mac when Rollup's native optional
package fails under the Codex-bundled Node runtime.

## Stop-Ship Gates

Stop and report instead of shipping if:

- any execution route can run without Governor authority or explicit
  machine-origin policy
- a local intent detector, wording veto, pending branch, or stale mission state
  can fight the Governor
- blocked/interrupted work can be finalized as `success`
- provider output, secrets, or private ids would leak into logs, UI, or relay
  payloads
- schedule, creator, mission-control, publish/deploy, browser/computer-use, or
  public/network actions lack focused regressions
- Spark OS contract coverage reports high-agency legacy gates, cleanup queue
  items, dirty repo state, or critical duplicate-truth release blockers

<!-- SPARK FLEET STANDARD BLOCK v1 — canonical source: spark-compete/fleet/AGENT_GUIDE.md.
     This same block is mirrored into every repo's AGENTS.md and CLAUDE.md. Keep in sync. -->
## How agents work in this repo (Claude, Codex, Gemini — every LLM)

Many agents and sessions work these repos at the same time. There is a tiny **automatic**
workflow that keeps you from colliding. **There are no human-review steps — CI is the only
gate, and it is automatic.** This is coordination, not bureaucracy: claim, work, PR.

### Start of work — one command, then just work normally
```
python3 ~/spark-compete/scripts/fleet.py claim <this-repo-path> <area> <task>
```
You get your **own private worktree + branch + a lease** on `<area>`, so no other agent
edits the same files. It prints the folder to `cd` into. Work there and commit as usual —
a pre-commit hook **auto-checks and renews your lease**; you never manage it by hand.

- `fleet board` — see who's working on what, right now
- `fleet handoff <agent> --note "..."` — pass your work to another agent (with context)
- `fleet release --here` — done (frees the area + removes the worktree)

### Landing work — fully automatic, no human approval
1. Open a PR to the default branch.
2. **CI is the gate.** When it's green, the PR merges. No human reviews anything.
3. Never push directly to the protected branch; never commit from the shared checkout —
   always from your worktree.

### The rules (enforced by CI, not by people)
Full ruleset: **`spark-cli/docs/harness-discipline/`** — `01_RULESET.md` (7 Prime
Directives · Red Lines RL-01..21 · Rules R-01..28) and `07_FLEET_DISCIPLINE.md` (this
workflow). The day-to-day essentials:
- A real fix targets the **root cause**, not a symptom (R-05).
- No regex / keyword / canned answer **owns authority** — it is evidence only (RL-01).
- A failure **surfaces** with a clear reason; it never becomes a fake success (RL-08).
- One worktree per task; PRs only; nothing bypasses the CI gate (F-01 / F-09).

That's the whole contract. The system handles coordination and the gate for you —
automatically, with no human in the loop.
<!-- END SPARK FLEET STANDARD BLOCK v1 -->
