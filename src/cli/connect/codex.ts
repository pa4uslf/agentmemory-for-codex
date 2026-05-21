import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsonSafe,
  writeJsonAtomic,
} from "./util.js";
import {
  buildMergedHooks,
  findPluginRoot,
  type HookManifest,
} from "./codex-hooks.js";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_TOML = join(CODEX_DIR, "config.toml");
const CODEX_HOOKS = join(CODEX_DIR, "hooks.json");
const MCP_NAME = "agentmemory";
const MCP_COMMAND = ["npx", "-y", "@agentmemory/mcp"] as const;
const DEFAULT_AGENTMEMORY_URL = "http://localhost:3111";

export function buildCodexMcpAddArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "mcp",
    "add",
    "--env",
    `AGENTMEMORY_URL=${env["AGENTMEMORY_URL"] || DEFAULT_AGENTMEMORY_URL}`,
  ];

  if (env["AGENTMEMORY_SECRET"]) {
    args.push("--env", `AGENTMEMORY_SECRET=${env["AGENTMEMORY_SECRET"]}`);
  }

  args.push(MCP_NAME, "--", ...MCP_COMMAND);
  return args;
}

export function getOutputLooksWired(output: string): boolean {
  return (
    output.includes(MCP_NAME) &&
    output.includes(MCP_COMMAND[0]) &&
    output.includes("@agentmemory/mcp")
  );
}

function runCodex(args: string[]): string {
  return execFileSync("codex", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasCodexCli(): boolean {
  try {
    runCodex(["--version"]);
    return true;
  } catch {
    return false;
  }
}

function getExistingCodexServer(): string | null {
  try {
    return runCodex(["mcp", "get", MCP_NAME]);
  } catch {
    return null;
  }
}

export const adapter: ConnectAdapter = {
  name: "codex",
  displayName: "Codex CLI",
  docs: "https://github.com/rohitg00/agentmemory#codex-cli-codex-plugin-platform",
  protocolNote:
    "→ Using MCP. Hooks ship via the Codex plugin; on Codex Desktop, also pass --with-hooks to install the global hooks.json workaround for openai/codex#16430.",

  detect(): boolean {
    return existsSync(CODEX_DIR) || hasCodexCli();
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const existing = getExistingCodexServer();
    const wired = existing !== null;

    if (wired && !opts.force) {
      logAlreadyWired("Codex CLI", CODEX_TOML);
      return { kind: "already-wired", mutatedPath: CODEX_TOML };
    }

    if (opts.dryRun) {
      p.log.info(
        `[dry-run] Would run: codex ${buildCodexMcpAddArgs().join(" ")}`,
      );
      if (opts.withHooks) installCodexHooks(opts);
      return { kind: "installed", mutatedPath: CODEX_TOML };
    }

    let backupPath: string | undefined;
    if (existsSync(CODEX_TOML)) {
      backupPath = backupFile(CODEX_TOML, "codex", "toml");
      logBackup(backupPath);
    }

    if (wired) {
      runCodex(["mcp", "remove", MCP_NAME]);
    }

    runCodex(buildCodexMcpAddArgs());

    const verify = getExistingCodexServer();
    if (verify === null || !getOutputLooksWired(verify)) {
      p.log.error(
        `Verification failed: \`codex mcp get ${MCP_NAME}\` did not show the expected @agentmemory/mcp server.`,
      );
      return { kind: "skipped", reason: "verification-failed" };
    }

    logInstalled("Codex CLI", CODEX_TOML);
    p.log.info(
      "Codex picks up MCP servers on next launch. For the deeper plugin install, run: codex plugin marketplace add rohitg00/agentmemory && codex plugin add agentmemory@agentmemory",
    );

    if (opts.withHooks) {
      const hookResult = installCodexHooks(opts);
      if (hookResult.kind === "skipped") {
        p.log.warn(
          `Codex hooks fallback skipped: ${hookResult.reason}. MCP wiring still applied.`,
        );
      }
    }

    return {
      kind: "installed",
      mutatedPath: CODEX_TOML,
      ...(backupPath !== undefined && { backupPath }),
    };
  },
};

/**
 * Install the global `~/.codex/hooks.json` fallback. See
 * `codex-hooks.ts` for context (openai/codex#16430). Returns a result
 * describing the side effect for the caller's summary; failures here do
 * not roll back the MCP wiring.
 */
function installCodexHooks(opts: ConnectOptions): ConnectResult {
  let pluginRoot: string;
  try {
    pluginRoot = findPluginRoot();
  } catch (err) {
    return {
      kind: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const existing = readJsonSafe<HookManifest>(CODEX_HOOKS);
  const merged = buildMergedHooks(existing, pluginRoot);

  if (opts.dryRun) {
    p.log.info(
      `[dry-run] Would ${existing ? "merge" : "create"} ${CODEX_HOOKS} with ${Object.keys(merged.hooks).length} event(s)`,
    );
    return { kind: "installed", mutatedPath: CODEX_HOOKS };
  }

  let backupPath: string | undefined;
  if (existsSync(CODEX_HOOKS)) {
    backupPath = backupFile(CODEX_HOOKS, "codex-hooks", "json");
    logBackup(backupPath);
  }

  writeJsonAtomic(CODEX_HOOKS, merged);

  logInstalled("Codex hooks (workaround for openai/codex#16430)", CODEX_HOOKS);
  p.log.info(
    "User-scope hooks reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect codex --with-hooks` after upgrading agentmemory to refresh them.",
  );

  return {
    kind: "installed",
    mutatedPath: CODEX_HOOKS,
    ...(backupPath !== undefined && { backupPath }),
  };
}
