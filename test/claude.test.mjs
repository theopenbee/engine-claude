import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArgs, claudeBaseDirs, collectUsage, extractResultFromLog, mcpConfig, scanResultLog } from "../dist/claude.js";

const here = dirname(fileURLToPath(import.meta.url));
const logs = join(here, "fixtures", "logs");
const configFixture = join(here, "fixtures", "config");
const scratch = mkdtempSync(join(tmpdir(), "engine-claude-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir, relative, content) {
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

const FIXED_ARGS = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];

test("buildArgs without a session", () => {
  assert.deepEqual(buildArgs({ session_id: "", resume: false, extra_args: [] }), [...FIXED_ARGS, "--print"]);
});

test("buildArgs starts a new session with --session-id", () => {
  assert.deepEqual(buildArgs({ session_id: "s1", resume: false, extra_args: [] }), [...FIXED_ARGS, "--session-id", "s1", "--print"]);
});

test("buildArgs resumes a session with --resume", () => {
  assert.deepEqual(buildArgs({ session_id: "s2", resume: true, extra_args: [] }), [...FIXED_ARGS, "--resume", "s2", "--print"]);
});

test("buildArgs puts extra args between the session flags and --print", () => {
  assert.deepEqual(buildArgs({ session_id: "s3", resume: false, extra_args: ["--model", "opus"] }), [
    ...FIXED_ARGS,
    "--session-id",
    "s3",
    "--model",
    "opus",
    "--print",
  ]);
});

test("buildArgs tolerates missing extra args", () => {
  assert.deepEqual(buildArgs({ session_id: "s4", resume: false }), [...FIXED_ARGS, "--session-id", "s4", "--print"]);
});

test("buildArgs adds the MCP config before the session flags", () => {
  const mcp = { name: "openbee", url: "http://127.0.0.1:9000/mcp", api_key_env: "OPENBEE_API_KEY" };
  const args = buildArgs({ session_id: "s5", resume: true, extra_args: ["--model", "x"], mcp });
  assert.deepEqual(args, [...FIXED_ARGS, `--mcp-config=${mcpConfig(mcp)}`, "--resume", "s5", "--model", "x", "--print"]);
});

test("buildArgs skips the MCP config when the URL is empty", () => {
  const args = buildArgs({ session_id: "", resume: false, extra_args: [], mcp: { name: "openbee", url: "", api_key_env: "OPENBEE_API_KEY" } });
  assert.deepEqual(args, [...FIXED_ARGS, "--print"]);
});

test("mcpConfig matches the config the Go engine produced", () => {
  const config = mcpConfig({ name: "openbee", url: "http://127.0.0.1:9000/mcp", api_key_env: "OPENBEE_API_KEY" });
  assert.deepEqual(JSON.parse(config), {
    mcpServers: {
      openbee: {
        type: "http",
        url: "http://127.0.0.1:9000/mcp",
        headers: { Authorization: "Bearer ${OPENBEE_API_KEY}" },
        alwaysLoad: true,
      },
    },
  });
  assert.ok(config.includes("Bearer ${OPENBEE_API_KEY}"));
});

test("mcpConfig uses the server name and key variable from the request", () => {
  const config = JSON.parse(mcpConfig({ name: "bee-mcp", url: "http://h:1/mcp", api_key_env: "MY_KEY" }));
  assert.deepEqual(Object.keys(config.mcpServers), ["bee-mcp"]);
  assert.equal(config.mcpServers["bee-mcp"].headers.Authorization, "Bearer ${MY_KEY}");
});

test("scanResultLog reports an error result", async () => {
  const scan = await scanResultLog(join(logs, "result-error.jsonl"));
  assert.equal(scan.isError, true);
  assert.equal(scan.result, 'API Error: 400 {"error":"操作失败"}');
});

test("scanResultLog reports a successful result", async () => {
  const scan = await scanResultLog(join(logs, "result-ok.jsonl"));
  assert.equal(scan.isError, false);
  assert.equal(scan.result, "all good");
});

test("scanResultLog without a result event", async () => {
  const scan = await scanResultLog(join(logs, "no-result.jsonl"));
  assert.equal(scan.isError, false);
  assert.equal(scan.result, "");
  assert.equal(scan.lastAssistantText, "hello");
});

test("scanResultLog stops at the first result event", async () => {
  const scan = await scanResultLog(join(logs, "stop-at-result.jsonl"));
  assert.deepEqual(scan, { result: "first result", isError: false, lastAssistantText: "before" });
});

test("scanResultLog of a missing file is empty", async () => {
  const scan = await scanResultLog(join(scratch, "no-such.log"));
  assert.deepEqual(scan, { result: "", isError: false, lastAssistantText: "" });
});

test("scanResultLog of an empty file is empty", async () => {
  const scan = await scanResultLog(join(logs, "empty.jsonl"));
  assert.deepEqual(scan, { result: "", isError: false, lastAssistantText: "" });
});

test("scanResultLog ignores noise lines and trims whitespace", async () => {
  const scan = await scanResultLog(join(logs, "noisy.jsonl"));
  assert.deepEqual(scan, { result: "noisy answer", isError: false, lastAssistantText: "indented" });
});

test("scanResultLog skips lines whose fields have the wrong type", async () => {
  const scan = await scanResultLog(join(logs, "bad-types.jsonl"));
  assert.deepEqual(scan, { result: "real result", isError: false, lastAssistantText: "kept" });
});

test("scanResultLog keeps an empty error result as an error", async () => {
  const scan = await scanResultLog(join(logs, "is-error-empty.jsonl"));
  assert.deepEqual(scan, { result: "", isError: true, lastAssistantText: "partial" });
});

test("scanResultLog handles Windows line endings", async () => {
  const path = writeFile(freshDir("crlf"), "run.log", '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}\r\n{"type":"result","is_error":false,"result":"b"}\r\n');
  assert.deepEqual(await scanResultLog(path), { result: "b", isError: false, lastAssistantText: "a" });
});

test("scanResultLog reads a result at the end of a large log", async () => {
  const filler = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}\n'.repeat(20000);
  const path = writeFile(freshDir("large"), "run.log", `${filler}{"type":"result","is_error":false,"result":"big"}\n`);
  assert.equal((await scanResultLog(path)).result, "big");
});

test("extractResultFromLog prefers the result event over assistant text", async () => {
  assert.equal(await extractResultFromLog(join(logs, "result-preferred.jsonl")), "final answer");
});

test("extractResultFromLog falls back to the last assistant text", async () => {
  assert.equal(await extractResultFromLog(join(logs, "last-assistant.jsonl")), "three");
});

test("extractResultFromLog falls back when the result is empty", async () => {
  assert.equal(await extractResultFromLog(join(logs, "empty-result.jsonl")), "fallback text");
});

test("extractResultFromLog only considers a text block at the start of an assistant message", async () => {
  assert.equal(await extractResultFromLog(join(logs, "first-content-only.jsonl")), "kept");
});

test("extractResultFromLog of an empty or missing log is empty", async () => {
  assert.equal(await extractResultFromLog(join(logs, "empty.jsonl")), "");
  assert.equal(await extractResultFromLog(join(scratch, "no-such.log")), "");
});

test("claudeBaseDirs defaults to ~/.claude and ~/.config/claude", () => {
  assert.deepEqual(claudeBaseDirs({}, "/home/u"), [join("/home/u", ".claude"), join("/home/u", ".config", "claude")]);
});

test("claudeBaseDirs treats an empty CLAUDE_CONFIG_DIR as unset", () => {
  assert.deepEqual(claudeBaseDirs({ CLAUDE_CONFIG_DIR: "" }, "/home/u"), [join("/home/u", ".claude"), join("/home/u", ".config", "claude")]);
});

test("claudeBaseDirs uses only CLAUDE_CONFIG_DIR when it is set", () => {
  assert.deepEqual(claudeBaseDirs({ CLAUDE_CONFIG_DIR: "/data/claude" }, "/home/u"), ["/data/claude"]);
});

test("claudeBaseDirs splits CLAUDE_CONFIG_DIR on commas and trims entries", () => {
  assert.deepEqual(claudeBaseDirs({ CLAUDE_CONFIG_DIR: " /a/one , ,/b/two,  " }, "/home/u"), ["/a/one", "/b/two"]);
});

test("collectUsage aggregates by model", async () => {
  const usage = await collectUsage([configFixture], ["aggregate-session"]);
  assert.deepEqual(Object.keys(usage), ["aggregate-session"]);
  const byModel = Object.fromEntries(usage["aggregate-session"].map((u) => [u.model, u]));
  assert.deepEqual(byModel["claude-3-5-sonnet"], {
    model: "claude-3-5-sonnet",
    input_tokens: 300,
    output_tokens: 150,
    cache_creation_tokens: 20,
    cache_read_tokens: 15,
  });
  assert.deepEqual(byModel["claude-3-opus"], {
    model: "claude-3-opus",
    input_tokens: 300,
    output_tokens: 150,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
  });
  assert.equal(usage["aggregate-session"].length, 2);
});

test("collectUsage suffixes fast speed models", async () => {
  const usage = await collectUsage([configFixture], ["fast-session"]);
  assert.deepEqual(usage["fast-session"], [
    { model: "claude-3-5-sonnet-fast", input_tokens: 100, output_tokens: 50, cache_creation_tokens: 0, cache_read_tokens: 0 },
    { model: "claude-3-5-sonnet", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("collectUsage skips the synthetic model", async () => {
  const usage = await collectUsage([configFixture], ["synthetic-session"]);
  assert.deepEqual(usage["synthetic-session"], [
    { model: "claude-3-5-sonnet", input_tokens: 100, output_tokens: 50, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("collectUsage survives malformed lines and entries without usage", async () => {
  const usage = await collectUsage([configFixture], ["robust-session"]);
  assert.deepEqual(usage["robust-session"], [
    { model: "claude-3-5-sonnet", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
});

test("collectUsage finds a session file in a nested directory", async () => {
  const usage = await collectUsage([configFixture], ["deep-session"]);
  assert.deepEqual(usage["deep-session"], [
    { model: "claude-3-opus", input_tokens: 11, output_tokens: 22, cache_creation_tokens: 33, cache_read_tokens: 44 },
  ]);
});

test("collectUsage omits sessions that cannot be found", async () => {
  const usage = await collectUsage([configFixture], ["aggregate-session", "nonexistent-session"]);
  assert.deepEqual(Object.keys(usage), ["aggregate-session"]);
});

test("collectUsage of an unknown session is empty", async () => {
  assert.deepEqual(await collectUsage([freshDir("empty-config")], ["nonexistent-session"]), {});
});

test("collectUsage tolerates base directories that do not exist", async () => {
  const usage = await collectUsage([join(scratch, "missing-1"), configFixture], ["fast-session"]);
  assert.deepEqual(Object.keys(usage), ["fast-session"]);
});

test("collectUsage prefers a flat file over a nested one", async () => {
  const base = freshDir("flat");
  writeFile(base, "projects/abc.jsonl", '{"message":{"model":"flat","usage":{"input_tokens":1}}}\n');
  writeFile(base, "projects/p/abc.jsonl", '{"message":{"model":"nested","usage":{"input_tokens":2}}}\n');
  const usage = await collectUsage([base], ["abc"]);
  assert.deepEqual(usage.abc.map((u) => u.model), ["flat"]);
});

test("collectUsage takes the first nested match in directory order", async () => {
  const base = freshDir("order");
  writeFile(base, "projects/b/abc.jsonl", '{"message":{"model":"b","usage":{"input_tokens":2}}}\n');
  writeFile(base, "projects/a/abc.jsonl", '{"message":{"model":"a","usage":{"input_tokens":1}}}\n');
  const usage = await collectUsage([base], ["abc"]);
  assert.deepEqual(usage.abc.map((u) => u.model), ["a"]);
});

test("collectUsage searches base directories in order", async () => {
  const first = freshDir("first");
  const second = freshDir("second");
  writeFile(first, "projects/p/only-first.jsonl", '{"message":{"model":"one","usage":{"input_tokens":1}}}\n');
  writeFile(second, "projects/p/only-second.jsonl", '{"message":{"model":"two","usage":{"input_tokens":2}}}\n');
  writeFile(first, "projects/p/both.jsonl", '{"message":{"model":"first","usage":{"input_tokens":1}}}\n');
  writeFile(second, "projects/p/both.jsonl", '{"message":{"model":"second","usage":{"input_tokens":2}}}\n');
  const usage = await collectUsage([first, second], ["only-first", "only-second", "both"]);
  assert.deepEqual(usage["only-first"].map((u) => u.model), ["one"]);
  assert.deepEqual(usage["only-second"].map((u) => u.model), ["two"]);
  assert.deepEqual(usage.both.map((u) => u.model), ["first"]);
});

test("collectUsage does not match a file name that merely ends with the session id", async () => {
  const base = freshDir("suffix");
  writeFile(base, "projects/p/prefix-abc.jsonl", '{"message":{"model":"x","usage":{"input_tokens":1}}}\n');
  assert.deepEqual(await collectUsage([base], ["abc"]), {});
});

test("collectUsage ignores session ids that are not plain file names", async () => {
  const base = freshDir("escape");
  writeFile(base, "secret.jsonl", '{"message":{"model":"x","usage":{"input_tokens":1}}}\n');
  assert.deepEqual(await collectUsage([base], ["../secret", "", "a/b", "a\\b"]), {});
});

test("collectUsage follows no symlinked directories", async () => {
  const base = freshDir("link");
  const outside = freshDir("outside");
  writeFile(outside, "linked.jsonl", '{"message":{"model":"x","usage":{"input_tokens":1}}}\n');
  mkdirSync(join(base, "projects"), { recursive: true });
  symlinkSync(outside, join(base, "projects", "link"), "dir");
  assert.deepEqual(await collectUsage([base], ["linked"]), {});
});
