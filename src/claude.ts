import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { cliVersion, findCli, log, spawnCli } from "@theopenbee/engine-sdk";
import type { Engine, EngineRequest, RunParams, RunResult, TokenUsage } from "@theopenbee/engine-sdk";

const SYNTHETIC_MODEL = "<synthetic>";
const EMPTY_ERROR_TEXT = "bee execution failed (no details available)";

type JsonObject = Record<string, unknown>;
type McpParams = NonNullable<RunParams["mcp"]>;

export interface ResultScan {
  result: string;
  isError: boolean;
  lastAssistantText: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function mcpConfig(mcp: McpParams): string {
  return JSON.stringify({
    mcpServers: {
      [mcp.name]: {
        type: "http",
        url: mcp.url,
        headers: { Authorization: `Bearer \${${mcp.api_key_env}}` },
        alwaysLoad: true,
      },
    },
  });
}

export function buildArgs(params: Pick<RunParams, "session_id" | "resume" | "extra_args" | "mcp">): string[] {
  const args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
  if (params.mcp?.url) args.push(`--mcp-config=${mcpConfig(params.mcp)}`);
  if (params.session_id) {
    args.push(params.resume ? "--resume" : "--session-id", params.session_id);
  }
  args.push(...(params.extra_args ?? []), "--print");
  return args;
}

function firstAssistantText(event: JsonObject): string {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return "";
  const first: unknown = message.content[0];
  if (isObject(first) && first.type === "text" && typeof first.text === "string") return first.text;
  return "";
}

export async function scanResultLog(logPath: string): Promise<ResultScan> {
  const scan: ResultScan = { result: "", isError: false, lastAssistantText: "" };
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const text = raw.trim();
      if (!text.startsWith("{")) continue;
      let event: unknown;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isObject(event)) continue;
      if (event.type === "assistant") {
        const assistantText = firstAssistantText(event);
        if (assistantText !== "") scan.lastAssistantText = assistantText;
      } else if (event.type === "result") {
        const result = event.result ?? "";
        const isError = event.is_error ?? false;
        if (typeof result !== "string" || typeof isError !== "boolean") continue;
        scan.result = result;
        scan.isError = isError;
        break;
      }
    }
  } catch {
    return scan;
  } finally {
    lines.close();
    stream.destroy();
  }
  return scan;
}

export async function extractResultFromLog(logPath: string): Promise<string> {
  const scan = await scanResultLog(logPath);
  return scan.result !== "" ? scan.result : scan.lastAssistantText;
}

export function claudeBaseDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) {
    return configured
      .split(",")
      .map((dir) => dir.trim())
      .filter((dir) => dir !== "");
  }
  return [join(home, ".claude"), join(home, ".config", "claude")];
}

export function sessionBaseDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = claudeBaseDirs(env, home);
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured && !dirs.includes(configured)) dirs.push(configured);
  return dirs;
}

function isPlainFileName(id: unknown): id is string {
  return typeof id === "string" && id !== "" && !/[\\/\0]/.test(id);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function sessionExists(baseDirs: string[], sessionId: string): boolean {
  if (!isPlainFileName(sessionId)) return false;
  const name = `${sessionId}.jsonl`;
  for (const base of baseDirs) {
    const root = join(base, "projects");
    if (isFile(join(root, name))) return true;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    if (entries.some((entry) => isFile(join(root, entry, name)))) return true;
  }
  return false;
}

function indexJsonlFiles(dir: string, index: Map<string, string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isMissing(err)) log.warn(`reading ${dir} failed: ${errorMessage(err)}`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) indexJsonlFiles(full, index);
    else if (entry.name.endsWith(".jsonl") && !index.has(entry.name)) index.set(entry.name, full);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function parseSessionFile(path: string): Promise<TokenUsage[]> {
  const byModel = new Map<string, TokenUsage>();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject(event) || !isObject(event.message)) continue;
      const message = event.message;
      if (typeof message.model !== "string" || message.model === "" || message.model === SYNTHETIC_MODEL) continue;
      if (!isObject(message.usage)) continue;
      const model = message.speed === "fast" ? `${message.model}-fast` : message.model;
      let total = byModel.get(model);
      if (!total) {
        total = { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
        byModel.set(model, total);
      }
      total.input_tokens += numberOrZero(message.usage.input_tokens);
      total.output_tokens += numberOrZero(message.usage.output_tokens);
      total.cache_creation_tokens += numberOrZero(message.usage.cache_creation_input_tokens);
      total.cache_read_tokens += numberOrZero(message.usage.cache_read_input_tokens);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...byModel.values()];
}

export async function collectUsage(baseDirs: string[], sessionIds: string[]): Promise<Record<string, TokenUsage[]>> {
  const nestedIndexes = new Map<string, Map<string, string>>();
  const nestedIndex = (root: string): Map<string, string> => {
    let index = nestedIndexes.get(root);
    if (!index) {
      index = new Map();
      indexJsonlFiles(root, index);
      nestedIndexes.set(root, index);
    }
    return index;
  };

  const found = new Map<string, TokenUsage[]>();
  for (const id of sessionIds) {
    if (!isPlainFileName(id) || found.has(id)) continue;
    const name = `${id}.jsonl`;
    let path: string | undefined;
    for (const base of baseDirs) {
      const root = join(base, "projects");
      const flat = join(root, name);
      path = isFile(flat) ? flat : nestedIndex(root).get(name);
      if (path) break;
    }
    if (!path) continue;
    try {
      found.set(id, await parseSessionFile(path));
    } catch (err) {
      log.warn(`reading session ${id} failed: ${errorMessage(err)}`);
    }
  }
  return Object.fromEntries(found);
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  if (code === null) return `claude was terminated by signal ${signal ?? "unknown"}`;
  return `claude exited with code ${code}`;
}

export const engine: Engine = {
  async check(req) {
    const path = findCli(req.config, "claude");
    return { version: await cliVersion(path), path };
  },

  async run(req: EngineRequest<RunParams>): Promise<RunResult> {
    const params = req.params;
    const command = findCli(req.config, "claude");
    const resume = params.resume && sessionExists(sessionBaseDirs(), params.session_id);

    let outcome;
    try {
      outcome = await spawnCli({
        command,
        args: buildArgs({ ...params, resume }),
        cwd: params.work_dir,
        env: { DISABLE_AUTOUPDATER: "1" },
        input: params.prompt,
        logPath: params.log_path,
      });
    } catch (err) {
      throw new Error(`start claude: ${errorMessage(err)}`);
    }

    const scan = await scanResultLog(params.log_path);
    const text = scan.result !== "" ? scan.result : scan.lastAssistantText;
    if (outcome.code !== 0) {
      const detail = scan.isError && scan.result !== "" ? scan.result : exitText(outcome.code, outcome.signal);
      return { text, error: detail };
    }
    if (scan.isError) return { text, error: scan.result !== "" ? scan.result : EMPTY_ERROR_TEXT };
    return { text };
  },

  async usage(req) {
    return collectUsage(claudeBaseDirs(), req.params.session_ids ?? []);
  },
};
