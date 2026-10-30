import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const entry = join(root, "dist", "index.js");
const configFixture = join(here, "fixtures", "config");
const scratch = mkdtempSync(join(tmpdir(), "engine-claude-e2e-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function findBun() {
  const probe = spawnSync("bun", ["-e", "console.log(process.execPath)"]);
  if (probe.status === 0) return probe.stdout.toString().trim();
  const runtime = join(homedir(), ".openbee", "runtime");
  if (!existsSync(runtime)) return null;
  for (const name of readdirSync(runtime)) {
    const candidate = join(runtime, name, "bun");
    if (name.startsWith("bun-") && existsSync(candidate)) return candidate;
  }
  return null;
}

const bun = findBun();
const runtimes = [
  { name: "node", command: process.execPath, skip: false },
  { name: "bun", command: bun, skip: bun ? false : "bun is not installed" },
];

const line = (event) => JSON.stringify(event);

const OK_STDOUT = [
  { type: "system", subtype: "init", session_id: "abc" },
  { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "almost there" }] } },
  { type: "result", subtype: "success", is_error: false, result: "final answer" },
]
  .map(line)
  .join("\n");

const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write((process.env.FAKE_CLAUDE_VERSION || "2.1.314 (Claude Code)") + "\\n");
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CLAUDE_RECORD) {
  fs.writeFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      stdin,
      pid: process.pid,
      env: {
        OPENBEE_API_KEY: process.env.OPENBEE_API_KEY ?? null,
        DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER ?? null,
        NO_PROXY: process.env.NO_PROXY ?? null,
      },
    }),
  );
}
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (mode === "ok") {
  process.stderr.write("a warning on stderr\\n");
  process.stdout.write(${JSON.stringify(OK_STDOUT)} + "\\n");
} else if (mode === "no-result") {
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "only assistant text" }] } }) + "\\n",
  );
} else if (mode === "is-error") {
  process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "API Error: 400 {}" }) + "\\n");
} else if (mode === "is-error-empty") {
  process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "" }) + "\\n");
} else if (mode === "error-exit") {
  process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" }) + "\\n");
  process.exit(1);
} else if (mode === "stderr-exit") {
  process.stderr.write("boom\\n");
  process.exit(2);
} else if (mode === "silent-exit") {
  process.exit(3);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGKILL");
} else if (mode === "sleep") {
  setInterval(() => {}, 1000);
}
`;

const fakeClaude = join(scratch, "bin", "claude");
before(() => {
  mkdirSync(dirname(fakeClaude), { recursive: true });
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  chmodSync(fakeClaude, 0o755);
});

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkdirpSync(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseRequest(method, params, overrides = {}) {
  return {
    protocol_version: 1,
    method,
    openbee_version: "9.9.9",
    engine_id: "claude",
    language: "en",
    config: { path: fakeClaude },
    data_dir: freshDir("data"),
    state_dir: freshDir("state"),
    params,
    ...overrides,
  };
}

function pluginEnv(env) {
  const merged = { ...process.env, OPENBEE_API_KEY: "tok-secret", ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

function runPlugin(runtime, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [entry], { cwd: scratch, env: pluginEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

function response(res) {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${res.stdout}`);
  return JSON.parse(lines[0]);
}

function runParams(overrides = {}) {
  return {
    role: "worker",
    work_dir: freshDir("work"),
    prompt: "hello",
    session_id: "4d0ce91b-0856-44e2-b0d7-7765d824bba3",
    resume: false,
    extra_args: [],
    log_path: join(freshDir("logs"), "exec.log"),
    ...overrides,
  };
}

function recordedCall(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const FIXED_ARGS = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];

async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const runtime of runtimes) {
  const t = (name, fn, options = {}) => test(`[${runtime.name}] ${name}`, { skip: runtime.skip || options.skip }, fn);

  t("check returns the version and path", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {})));
    assert.deepEqual(res, { result: { version: "2.1.314 (Claude Code)", path: fakeClaude } });
  });

  t("check fails when the configured path does not exist", async () => {
    const missing = join(scratch, "no-such-claude");
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: missing } })));
    assert.deepEqual(res, { error: { message: `${missing} not found` } });
  });

  t("check fails with claude not found on PATH", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: {} }), { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "claude not found on PATH" } });
  });

  t("check uses claude from PATH when no path is configured", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: "" } }), { PATH: dirname(fakeClaude) }));
    assert.deepEqual(res, { result: { version: "2.1.314 (Claude Code)", path: fakeClaude } });
  });

  t("run passes the claude arguments and returns the result text", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest("run", runParams({ prompt: "do the thing", extra_args: ["--model", "opus"] }));
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    assert.deepEqual(call.argv, [...FIXED_ARGS, "--session-id", req.params.session_id, "--model", "opus", "--print"]);
    assert.equal(call.stdin, "do the thing");
    assert.equal(call.cwd, realpathSync(req.params.work_dir));
  });

  t("run resumes a session whose file is flat under CLAUDE_CONFIG_DIR", async () => {
    const record = join(freshDir("rec"), "call.json");
    const config = freshDir("config");
    writeFileSync(join(mkdirpSync(join(config, "projects")), "resume-me.jsonl"), "{}\n");
    const req = baseRequest("run", runParams({ resume: true, session_id: "resume-me" }));
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: config }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--resume", "resume-me", "--print"]);
  });

  t("run resumes a session whose file is in a project directory", async () => {
    const record = join(freshDir("rec"), "call.json");
    const config = freshDir("config");
    writeFileSync(join(mkdirpSync(join(config, "projects", "-Users-me-work")), "resume-me.jsonl"), "{}\n");
    const req = baseRequest("run", runParams({ resume: true, session_id: "resume-me" }));
    response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: config }));
    assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--resume", "resume-me", "--print"]);
  });

  t("run resumes a session found under ~/.claude or ~/.config/claude", async () => {
    const home = freshDir("home");
    writeFileSync(join(mkdirpSync(join(home, ".claude", "projects", "p")), "in-dot-claude.jsonl"), "{}\n");
    writeFileSync(join(mkdirpSync(join(home, ".config", "claude", "projects")), "in-config.jsonl"), "{}\n");
    const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined };
    for (const id of ["in-dot-claude", "in-config"]) {
      const record = join(freshDir("rec"), "call.json");
      const req = baseRequest("run", runParams({ resume: true, session_id: id }));
      response(await runPlugin(runtime, req, { ...env, FAKE_CLAUDE_RECORD: record }));
      assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--resume", id, "--print"]);
    }
  });

  t("run resumes a session under a CLAUDE_CONFIG_DIR that contains a comma", async () => {
    const record = join(freshDir("rec"), "call.json");
    const config = join(freshDir("config"), "team,claude");
    writeFileSync(join(mkdirpSync(join(config, "projects", "p")), "resume-me.jsonl"), "{}\n");
    const req = baseRequest("run", runParams({ resume: true, session_id: "resume-me" }));
    response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: config }));
    assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--resume", "resume-me", "--print"]);
  });

  t("run starts a new session when the resumed one has no file", async () => {
    const record = join(freshDir("rec"), "call.json");
    const config = freshDir("config");
    writeFileSync(join(mkdirpSync(join(config, "projects", "p")), "another-session.jsonl"), "{}\n");
    const req = baseRequest("run", runParams({ resume: true, session_id: "never-created" }));
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: config }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--session-id", "never-created", "--print"]);
  });

  t("run keeps extra args and the MCP config when it falls back to a new session", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest(
      "run",
      runParams({
        resume: true,
        session_id: "never-created",
        extra_args: ["--model", "opus"],
        mcp: { name: "openbee", url: "http://127.0.0.1:9000/mcp", api_key_env: "OPENBEE_API_KEY" },
      }),
    );
    response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: freshDir("empty-config") }));
    const argv = recordedCall(record).argv;
    assert.deepEqual(argv.slice(-5), ["--session-id", "never-created", "--model", "opus", "--print"]);
    assert.ok(argv.some((arg) => arg.startsWith("--mcp-config=")));
    assert.ok(!argv.includes("--resume"));
  });

  t("run omits the session flags when there is no session id", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest("run", runParams({ session_id: "" }));
    response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, [...FIXED_ARGS, "--print"]);
  });

  t("run writes the claude output and stderr to the log", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req));
    const log = readFileSync(req.params.log_path, "utf8");
    assert.ok(log.includes('"subtype":"success"'));
    assert.ok(log.includes('"result":"final answer"'));
    assert.ok(log.includes("a warning on stderr"));
    assert.ok(log.endsWith("\n"));
  });

  t("run adds the MCP config with a key placeholder and keeps the key out of the arguments", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest(
      "run",
      runParams({
        extra_args: ["--model", "opus"],
        mcp: { name: "openbee", url: "http://127.0.0.1:12350/mcp", api_key_env: "OPENBEE_API_KEY" },
      }),
    );
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    const mcpArg = call.argv.find((arg) => arg.startsWith("--mcp-config="));
    assert.ok(mcpArg, "missing --mcp-config");
    assert.deepEqual(JSON.parse(mcpArg.slice("--mcp-config=".length)), {
      mcpServers: {
        openbee: {
          type: "http",
          url: "http://127.0.0.1:12350/mcp",
          headers: { Authorization: "Bearer ${OPENBEE_API_KEY}" },
          alwaysLoad: true,
        },
      },
    });
    assert.deepEqual(call.argv, [...FIXED_ARGS, mcpArg, "--session-id", req.params.session_id, "--model", "opus", "--print"]);
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.ok(!JSON.stringify(call.argv).includes("tok-secret"));
  });

  t("run uses the MCP server name and key variable from the request", async () => {
    const record = join(freshDir("rec"), "call.json");
    const req = baseRequest(
      "run",
      runParams({ mcp: { name: "bee-mcp", url: "http://h:1/mcp", api_key_env: "BEE_TOKEN" } }),
    );
    response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record, BEE_TOKEN: "other-secret" }));
    const call = recordedCall(record);
    const config = JSON.parse(call.argv.find((arg) => arg.startsWith("--mcp-config=")).slice("--mcp-config=".length));
    assert.deepEqual(Object.keys(config.mcpServers), ["bee-mcp"]);
    assert.equal(config.mcpServers["bee-mcp"].headers.Authorization, "Bearer ${BEE_TOKEN}");
    assert.ok(!JSON.stringify(call.argv).includes("other-secret"));
  });

  t("run passes no MCP config when openbee has no MCP address", async () => {
    const record = join(freshDir("rec"), "call.json");
    response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_RECORD: record }));
    assert.ok(!recordedCall(record).argv.some((arg) => arg.startsWith("--mcp-config")));
  });

  t("run disables auto-update and passes the environment through", async () => {
    const record = join(freshDir("rec"), "call.json");
    response(
      await runPlugin(runtime, baseRequest("run", runParams()), {
        FAKE_CLAUDE_RECORD: record,
        DISABLE_AUTOUPDATER: "0",
        NO_PROXY: "127.0.0.1,example.com",
      }),
    );
    const call = recordedCall(record);
    assert.equal(call.env.DISABLE_AUTOUPDATER, "1");
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.equal(call.env.NO_PROXY, "127.0.0.1,example.com");
  });

  t("run delivers a multi-megabyte unicode prompt on stdin unchanged", async () => {
    const record = join(freshDir("rec"), "call.json");
    const prompt = `line one\n"quoted" 'single' \`tick\` $HOME \\n back\\slash\n${"emoji \u{1F41D} 你好 <tag> & more\n".repeat(150000)}end`;
    assert.ok(Buffer.byteLength(prompt) > 3 * 1024 * 1024);
    const req = baseRequest("run", runParams({ prompt }));
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    const call = recordedCall(record);
    assert.equal(call.stdin, prompt);
    assert.ok(!call.argv.includes(prompt));
  });

  t("run falls back to the last assistant text without a result event", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "no-result" }));
    assert.deepEqual(res, { result: { text: "only assistant text" } });
  });

  t("run reports an is_error result even when claude exits 0", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "is-error" }));
    assert.deepEqual(res, { result: { text: "API Error: 400 {}", error: "API Error: 400 {}" } });
  });

  t("run reports a default message for an is_error result without text", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "is-error-empty" }));
    assert.deepEqual(res, { result: { text: "", error: "bee execution failed (no details available)" } });
  });

  t("run reports the CLI result text when claude exits non-zero with an error result", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "error-exit" }));
    assert.deepEqual(res, { result: { text: "Credit balance is too low", error: "Credit balance is too low" } });
  });

  t("run reports the exit code when claude exits non-zero without a result", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_CLAUDE_MODE: "stderr-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "claude exited with code 2" } });
    assert.ok(readFileSync(req.params.log_path, "utf8").includes("boom"));
  });

  t("run reports the exit code when claude exits non-zero silently", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "silent-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "claude exited with code 3" } });
  });

  t(
    "run reports the signal when claude is killed",
    async () => {
      const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "signal" }));
      assert.deepEqual(res, { result: { text: "", error: "claude was terminated by signal SIGKILL" } });
    },
    { skip: process.platform === "win32" },
  );

  t("run without any output returns empty text and no error", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CLAUDE_MODE: "none" }));
    assert.deepEqual(res, { result: { text: "" } });
  });

  t("run fails when claude cannot be found", async () => {
    const req = baseRequest("run", runParams(), { config: {} });
    const res = response(await runPlugin(runtime, req, { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "claude not found on PATH" } });
  });

  t("run fails when the working directory does not exist", async () => {
    const req = baseRequest("run", runParams({ work_dir: join(scratch, "no-such-dir") }));
    const res = response(await runPlugin(runtime, req));
    assert.ok(res.error.message.startsWith("start claude: "), res.error.message);
  });

  t(
    "stopping the plugin's process group kills claude",
    async () => {
      const record = join(freshDir("rec"), "call.json");
      const req = baseRequest("run", runParams());
      const child = spawn(runtime.command, [entry], {
        cwd: scratch,
        env: pluginEnv({ FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_MODE: "sleep" }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(req) + "\n");
      const closed = new Promise((resolve) => child.on("close", resolve));
      await waitFor(() => existsSync(record) && readFileSync(record, "utf8") !== "", "claude to start");
      const claudePid = recordedCall(record).pid;
      assert.ok(isAlive(claudePid));
      process.kill(-child.pid, "SIGKILL");
      await closed;
      await waitFor(() => !isAlive(claudePid), "claude to exit");
    },
    { skip: process.platform === "win32" },
  );

  t("usage reads sessions from CLAUDE_CONFIG_DIR and omits missing ones", async () => {
    const req = baseRequest("usage", { session_ids: ["aggregate-session", "no-such-session", "deep-session"] });
    const res = response(await runPlugin(runtime, req, { CLAUDE_CONFIG_DIR: configFixture }));
    assert.deepEqual(Object.keys(res.result.usage).sort(), ["aggregate-session", "deep-session"]);
    const byModel = Object.fromEntries(res.result.usage["aggregate-session"].map((u) => [u.model, u]));
    assert.deepEqual(byModel["claude-3-5-sonnet"], {
      model: "claude-3-5-sonnet",
      input_tokens: 300,
      output_tokens: 150,
      cache_creation_tokens: 20,
      cache_read_tokens: 15,
    });
    assert.equal(byModel["claude-3-opus"].input_tokens, 300);
    assert.equal(res.result.usage["deep-session"][0].cache_read_tokens, 44);
  });

  t("usage falls back to ~/.claude and ~/.config/claude", async () => {
    const home = freshDir("home");
    mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
    mkdirSync(join(home, ".config", "claude", "projects", "q"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "p", "in-dot-claude.jsonl"), '{"message":{"model":"m1","usage":{"input_tokens":1,"output_tokens":2}}}\n');
    writeFileSync(join(home, ".config", "claude", "projects", "q", "in-config.jsonl"), '{"message":{"model":"m2","usage":{"input_tokens":3,"output_tokens":4}}}\n');
    const req = baseRequest("usage", { session_ids: ["in-dot-claude", "in-config", "neither"] });
    const res = response(await runPlugin(runtime, req, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined }));
    assert.deepEqual(res.result.usage, {
      "in-dot-claude": [{ model: "m1", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 }],
      "in-config": [{ model: "m2", input_tokens: 3, output_tokens: 4, cache_creation_tokens: 0, cache_read_tokens: 0 }],
    });
  });

  t("usage with an empty config directory returns an empty map", async () => {
    const req = baseRequest("usage", { session_ids: ["a", "b"] });
    const res = response(await runPlugin(runtime, req, { CLAUDE_CONFIG_DIR: freshDir("empty-config") }));
    assert.deepEqual(res, { result: { usage: {} } });
  });

  t("usage with no session ids returns an empty map", async () => {
    const req = baseRequest("usage", { session_ids: [] });
    const res = response(await runPlugin(runtime, req, { CLAUDE_CONFIG_DIR: configFixture }));
    assert.deepEqual(res, { result: { usage: {} } });
  });
}
