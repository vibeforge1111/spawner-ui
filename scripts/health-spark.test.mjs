import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  healthEnvValue,
  healthRequiresCodex,
  resolveSparkWorkspaceRoot,
  shouldRepairHostedWorkspaceOwnership,
  sparkHealthAuthHeaders,
} from "./health-spark.mjs";

function runNodeScript(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("resolveSparkWorkspaceRoot", () => {
  it("prefers explicit Spark workspace roots", () => {
    expect(
      resolveSparkWorkspaceRoot({
        SPARK_WORKSPACE_ROOT: "/tmp/explicit",
        SPAWNER_WORKSPACE_ROOT: "/tmp/spawner",
        SPARK_HOME: "/tmp/spark-home",
      }),
    ).toBe("/tmp/explicit");
  });

  it("uses SPARK_HOME for sandboxed installs", () => {
    expect(
      resolveSparkWorkspaceRoot({
        SPARK_HOME: "/tmp/spark-home",
      }),
    ).toBe(join("/tmp/spark-home", "workspaces"));
  });

  it("falls back to the user Spark home only when no sandbox is provided", () => {
    expect(resolveSparkWorkspaceRoot({}, "/home/example")).toBe(join("/home/example", ".spark", "workspaces"));
  });
});

describe("healthRequiresCodex", () => {
  it("does not require Codex just because the provider is listed", () => {
    expect(
      healthRequiresCodex([{ id: "codex", configured: false, cliConfigured: false }], {
        DEFAULT_MISSION_PROVIDER: "zai",
      }),
    ).toBe(false);
  });

  it("requires Codex when it is the selected mission provider", () => {
    expect(
      healthRequiresCodex([{ id: "codex", configured: false, cliConfigured: false }], {
        DEFAULT_MISSION_PROVIDER: "codex",
      }),
    ).toBe(true);
  });

  it("requires Codex when the provider is actually configured", () => {
    expect(healthRequiresCodex([{ id: "codex", cliConfigured: true }], {})).toBe(true);
  });
});

describe("sparkHealthAuthHeaders", () => {
  it("uses the hosted UI key for local private health probes", () => {
    expect(sparkHealthAuthHeaders({ SPARK_UI_API_KEY: "ui", SPARK_BRIDGE_API_KEY: "bridge" })).toEqual({
      "x-spawner-ui-key": "ui",
      "x-api-key": "ui",
    });
  });

  it("falls back to the bridge key when no UI key is configured", () => {
    expect(sparkHealthAuthHeaders({ SPARK_BRIDGE_API_KEY: "bridge" })).toEqual({
      "x-spawner-ui-key": "bridge",
      "x-api-key": "bridge",
    });
  });

  it("falls back to the events key when UI and bridge keys are not configured", () => {
    expect(sparkHealthAuthHeaders({ EVENTS_API_KEY: "events", MCP_API_KEY: "mcp" })).toEqual({
      "x-spawner-ui-key": "events",
      "x-api-key": "events",
    });
  });

  it("falls back to the MCP key when only MCP control auth is configured", () => {
    expect(sparkHealthAuthHeaders({ MCP_API_KEY: "mcp" })).toEqual({
      "x-spawner-ui-key": "mcp",
      "x-api-key": "mcp",
    });
  });

  it("uses the requested key order for route-specific health probes", () => {
    expect(
      sparkHealthAuthHeaders(
        {
          SPARK_UI_API_KEY: "ui",
          SPARK_BRIDGE_API_KEY: "bridge",
          EVENTS_API_KEY: "events",
          MCP_API_KEY: "mcp",
        },
        ["EVENTS_API_KEY", "MCP_API_KEY", "SPARK_BRIDGE_API_KEY", "SPARK_UI_API_KEY"],
      ),
    ).toEqual({
      "x-spawner-ui-key": "ui",
      "x-api-key": "events",
    });
  });

  it("uses the route control key as UI auth only when no UI key is configured", () => {
    expect(
      sparkHealthAuthHeaders(
        {
          EVENTS_API_KEY: "events",
          MCP_API_KEY: "mcp",
        },
        ["EVENTS_API_KEY", "MCP_API_KEY"],
      ),
    ).toEqual({
      "x-spawner-ui-key": "events",
      "x-api-key": "events",
    });
  });
});

describe("healthEnvValue", () => {
  it("falls back to local .env values when process env omits a key", () => {
    const cwd = mkdtempSync(join(tmpdir(), "spawner-health-env-"));
    writeFileSync(join(cwd, ".env"), "MISSION_CONTROL_WEBHOOK_URLS=http://127.0.0.1:8788/spawner-events\n");

    expect(healthEnvValue("MISSION_CONTROL_WEBHOOK_URLS", {}, cwd)).toBe("http://127.0.0.1:8788/spawner-events");
  });

  it("honors an explicit empty process env value", () => {
    const cwd = mkdtempSync(join(tmpdir(), "spawner-health-env-"));
    writeFileSync(join(cwd, ".env"), "TELEGRAM_RELAY_SECRET=local-secret-that-should-not-win\n");

    expect(healthEnvValue("TELEGRAM_RELAY_SECRET", { TELEGRAM_RELAY_SECRET: "" }, cwd)).toBe("");
  });
  it("falls back to Spark module config when the key is absent from process env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "spawner-health-env-"));
    const sparkHome = join(cwd, ".spark");
    const moduleDir = join(sparkHome, "config", "modules");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "spawner-ui.env"), "TELEGRAM_RELAY_SECRET=module-value\n");
    // Also create a .env with a different value to ensure precedence
    writeFileSync(join(cwd, ".env"), "TELEGRAM_RELAY_SECRET=local-value\n");
    // Do not set TELEGRAM_RELAY_SECRET in process env
    expect(
      healthEnvValue("TELEGRAM_RELAY_SECRET", { SPARK_HOME: sparkHome }, cwd)
    ).toBe("module-value");
  });
  it("returns empty string when Spark module config key is absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "spawner-health-env-"));
    const sparkHome = join(cwd, ".spark");
    const moduleDir = join(sparkHome, "config", "modules");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "spawner-ui.env"), "OTHER_KEY=value\n");
    writeFileSync(join(cwd, ".env"), "TELEGRAM_RELAY_SECRET=local-value\n");
    expect(
      healthEnvValue("TELEGRAM_RELAY_SECRET", { SPARK_HOME: sparkHome }, cwd)
    ).toBe("local-value");
  });
});;

describe("shouldRepairHostedWorkspaceOwnership", () => {
  it("repairs Spark workspaces when health checks are accidentally run as root", () => {
    expect(
      shouldRepairHostedWorkspaceOwnership(
        {
          SPARK_HOME: "/data/spark",
        },
        0,
      ),
    ).toBe(true);
    expect(
      shouldRepairHostedWorkspaceOwnership(
        {
          SPARK_LIVE_CONTAINER: "1",
          SPARK_HOME: "/data/spark",
        },
        1001,
      ),
    ).toBe(false);
    expect(
      shouldRepairHostedWorkspaceOwnership(
        {
          SPARK_WORKSPACE_ROOT: "/data/spark/workspaces",
        },
        0,
      ),
    ).toBe(true);
    expect(shouldRepairHostedWorkspaceOwnership({}, 0)).toBe(false);
  });
});

describe("health-spark command", () => {
  it("checks the Spark run route without dispatching a mission", async () => {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      if (req.url === "/api/providers") {
        res.end(
          JSON.stringify({
            providers: [
              { id: "codex", configured: false, cliConfigured: false },
              { id: "zai", configured: true, cliConfigured: false },
            ],
          }),
        );
        return;
      }
      if (req.url === "/api/mission-control/board") {
        res.end(JSON.stringify({ board: { running: [], completed: [], failed: [] } }));
        return;
      }
      if (req.url === "/api/spark/run?health=1") {
        res.end(
          JSON.stringify({
            ok: true,
            route: "/api/spark/run",
            check: "route-loaded",
            dispatchesMission: false,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const workspaceRoot = mkdtempSync(join(tmpdir(), "spawner-health-workspace-"));
    try {
      const result = await runNodeScript(["scripts/health-spark.mjs"], {
        cwd: join(import.meta.dirname, ".."),
        env: {
          ...process.env,
          DEFAULT_MISSION_PROVIDER: "zai",
          SPAWNER_UI_URL: `http://127.0.0.1:${port}`,
          SPARK_WORKSPACE_ROOT: workspaceRoot,
          MISSION_CONTROL_WEBHOOK_URLS: "",
          TELEGRAM_RELAY_SECRET: "",
        },
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("spark_run=ready");
      expect(requests).toContain("/api/spark/run?health=1");
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("fails when mission webhook lacks relay secret", () => {
    const result = spawnSync(process.execPath, ["scripts/health-spark.mjs"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        MISSION_CONTROL_WEBHOOK_URLS: "http://127.0.0.1:8788/spawner-events",
        TELEGRAM_RELAY_SECRET: "",
      },
      encoding: "utf-8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TELEGRAM_RELAY_SECRET is missing");
  });
});
