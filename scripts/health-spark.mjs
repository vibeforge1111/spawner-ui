import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const spawnerPort = process.env.SPARK_SPAWNER_PORT || process.env.PORT || "3333";
const baseUrl = (process.env.SPAWNER_UI_URL || `http://127.0.0.1:${spawnerPort}`).replace(/\/$/, "");
const healthUrl = `${baseUrl}/api/providers`;
const boardUrl = `${baseUrl}/api/mission-control/board`;
const sparkRunHealthUrl = `${baseUrl}/api/spark/run?health=1`;
const DEFAULT_HEALTH_AUTH_KEY_ORDER = [
  "SPARK_UI_API_KEY",
  "SPARK_BRIDGE_API_KEY",
  "EVENTS_API_KEY",
  "MCP_API_KEY",
];
const MISSION_CONTROL_AUTH_KEY_ORDER = [
  "EVENTS_API_KEY",
  "MCP_API_KEY",
  "SPARK_BRIDGE_API_KEY",
  "SPARK_UI_API_KEY",
];
const SPARK_RUN_AUTH_KEY_ORDER = [
  "SPARK_BRIDGE_API_KEY",
  "MCP_API_KEY",
  "EVENTS_API_KEY",
  "SPARK_UI_API_KEY",
];

function parseCsv(value) {
	return String(value || "")
		.split(",")
    .map((item) => item.trim())
		.filter(Boolean);
}

function localEnvValue(key, cwd = process.cwd()) {
	const envPath = join(cwd, ".env");
	if (!existsSync(envPath)) return "";
	const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
	for (const line of [...lines].reverse()) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
		if (!match || match[1] !== key) continue;
		return match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
	}
	return "";
}

export function healthEnvValue(key, env = process.env, cwd = process.cwd()) {
	if (Object.prototype.hasOwnProperty.call(env, key)) return env[key]?.trim() || "";
	return localEnvValue(key, cwd);
}

function resolveCli(binaryName) {
  const upper = binaryName.toUpperCase();
  const configured =
    process.env[`${upper}_PATH`] ||
    process.env[`SPARK_${upper}_PATH`] ||
    process.env[`SPAWNER_${upper}_PATH`];
  if (configured && configured.trim()) return configured.trim();

  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(locator, [binaryName], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5000,
    });
    const matches = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === "win32") {
      return matches.find((line) => line.toLowerCase().endsWith(".cmd")) || matches[0] || null;
    }
    return matches[0] || null;
  } catch {
    return null;
  }
}

async function getJson(url, authKeyOrder = DEFAULT_HEALTH_AUTH_KEY_ORDER) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...sparkHealthAuthHeaders(process.env, authKeyOrder),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot reach ${url}: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }

  return await response.json();
}

export function sparkHealthAuthHeaders(env = process.env, keyOrder = DEFAULT_HEALTH_AUTH_KEY_ORDER) {
  const valueFor = (name) =>
    env === process.env ? healthEnvValue(name, env) : env[name]?.trim() || "";
  const controlKey = keyOrder.map((name) => valueFor(name)).find(Boolean);
  const uiKey = valueFor("SPARK_UI_API_KEY") || controlKey;
  if (!controlKey && !uiKey) return {};
  return {
    ...(uiKey ? { "x-spawner-ui-key": uiKey } : {}),
    ...(controlKey ? { "x-api-key": controlKey } : {}),
  };
}

export function resolveSparkWorkspaceRoot(env = process.env, fallbackHome = homedir()) {
  return (
    env.SPARK_WORKSPACE_ROOT?.trim() ||
    env.SPAWNER_WORKSPACE_ROOT?.trim() ||
    (env.SPARK_HOME?.trim() ? join(env.SPARK_HOME.trim(), "workspaces") : join(fallbackHome, ".spark", "workspaces"))
  );
}

export function shouldRepairHostedWorkspaceOwnership(env = process.env, getuid = process.getuid?.()) {
  return (
    getuid === 0 &&
    Boolean(env.SPARK_HOME?.trim() || env.SPARK_WORKSPACE_ROOT?.trim() || env.SPAWNER_WORKSPACE_ROOT?.trim())
  );
}

function repairHostedWorkspaceOwnership(paths, env = process.env) {
  if (!shouldRepairHostedWorkspaceOwnership(env)) return;
  const workspaceRoot = resolveSparkWorkspaceRoot(env);
  const ownerPath = env.SPARK_HOME?.trim() || dirname(workspaceRoot);
  let owner;
  try {
    owner = statSync(ownerPath);
  } catch {
    return;
  }
  if (owner.uid === 0) return;

  for (const path of paths) {
    try {
      chownSync(path, owner.uid, owner.gid);
    } catch {
      // Health checks should report service health, not fail just because an
      // ownership repair is unavailable on a particular host filesystem.
    }
  }
}

export function healthRequiresCodex(providers, env = process.env) {
  const selectedProvider =
    env.DEFAULT_MISSION_PROVIDER?.trim() ||
    env.SPAWNER_PRD_AUTO_PROVIDER?.trim() ||
    env.SPARK_MISSION_LLM_BOT_PROVIDER?.trim() ||
    env.SPARK_BOT_DEFAULT_PROVIDER?.trim() ||
    "";
  if (selectedProvider === "codex") return true;
  const codexProvider = providers.find((provider) => provider && provider.id === "codex");
  if (!codexProvider) return false;
  // OpenAI-compatible providers share OPENAI_API_KEY; do not treat that as Codex CLI selection.
  if (codexProvider.sparkSelected === true) return true;
  if (codexProvider.cliConfigured === true) return true;
  return false;
}

async function main() {
	const relayWebhooks = parseCsv(healthEnvValue("MISSION_CONTROL_WEBHOOK_URLS"));
	if (relayWebhooks.length > 0 && !healthEnvValue("TELEGRAM_RELAY_SECRET")) {
		throw new Error("MISSION_CONTROL_WEBHOOK_URLS is configured but TELEGRAM_RELAY_SECRET is missing");
	}

  const payload = await getJson(healthUrl);
  if (!payload || !Array.isArray(payload.providers)) {
    throw new Error("provider payload missing providers[]");
  }

  const configuredCount = payload.providers.filter(
    (provider) =>
      provider &&
      (provider.configured === true ||
        provider.envKeyConfigured === true ||
        provider.cliConfigured === true),
  ).length;
  const wantsCodex = healthRequiresCodex(payload.providers);
  const codexPath = wantsCodex ? resolveCli("codex") : null;

  if (wantsCodex && !codexPath) {
    throw new Error(
      "Codex provider is listed but codex is not resolvable. Install/login to Codex CLI or set CODEX_PATH.",
    );
  }

  const board = await getJson(boardUrl, MISSION_CONTROL_AUTH_KEY_ORDER);
  if (!board || typeof board !== "object") {
    throw new Error("mission board payload is not JSON");
  }

  const sparkRunHealth = await getJson(sparkRunHealthUrl, SPARK_RUN_AUTH_KEY_ORDER);
  if (!sparkRunHealth || sparkRunHealth.ok !== true || sparkRunHealth.dispatchesMission !== false) {
    throw new Error("spark run route health payload is not a non-dispatching OK probe");
  }

  const workspaceRoot = resolveSparkWorkspaceRoot();
  const smokeWorkspace = join(workspaceRoot, ".health-smoke");
  mkdirSync(smokeWorkspace, { recursive: true });
  repairHostedWorkspaceOwnership([workspaceRoot, smokeWorkspace]);
  const writeCheckPath = join(smokeWorkspace, "write-check.txt");
  writeFileSync(writeCheckPath, `spark-health ${new Date().toISOString()}\n`, "utf-8");
  repairHostedWorkspaceOwnership([workspaceRoot, smokeWorkspace, writeCheckPath]);

  if (process.env.SPARK_HEALTH_DEEP === "1") {
    const requestId = `health-${Date.now()}`;
    const runResponse = await fetch(`${baseUrl}/api/spark/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...sparkHealthAuthHeaders() },
      body: JSON.stringify({
        goal: "Reply with exactly: SPARK_HEALTH_OK",
        providers: ["codex"],
        promptMode: "simple",
        projectPath: smokeWorkspace,
        requestId,
      }),
    });
    if (!runResponse.ok) {
      const text = await runResponse.text().catch(() => "");
      throw new Error(`deep mission smoke failed to start: ${runResponse.status} ${text.slice(0, 300)}`);
    }
  }

  console.log(
    [
      `Spawner UI healthy: ${baseUrl}`,
      `${payload.providers.length} providers listed`,
      `${configuredCount} configured`,
      wantsCodex ? `codex=${codexPath}` : "codex=not-required",
      relayWebhooks.length > 0 ? `relay_webhooks=${relayWebhooks.length}` : "relay_webhooks=none",
      "spark_run=ready",
      `workspace=${smokeWorkspace}`,
    ].join(" | "),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Spawner UI unhealthy: ${message}`);
    process.exitCode = 1;
  });
}
