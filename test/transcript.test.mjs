import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { engine } from "../dist/claude.js";
import { readTranscript } from "../dist/transcript.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "transcript", "claude.jsonl");
const scratch = mkdtempSync(join(tmpdir(), "engine-claude-transcript-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function writeLog(events) {
  const path = join(scratch, `log-${++counter}.jsonl`);
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return path;
}

function toolUse(id, name, input) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
    timestamp: "2026-01-01T10:00:00.000Z",
  };
}

const FIXTURE_STEPS = [
  { type: "text", text: "I will start by looking at the project layout.\n\nThen I will run the tests." },
  { type: "thinking", text: "The tests probably live under the test directory." },
  {
    type: "tool",
    kind: "command",
    name: "Bash",
    summary: "npm test",
    output: "Error: no test specified\nexit code 1",
    status: "error",
    duration_ms: 1500,
  },
  {
    type: "tool",
    kind: "read",
    name: "Read",
    summary: "/work/demo/src/app.ts",
    output: '1\texport const answer = 42;\n2\texport const name = "demo";',
    status: "done",
    duration_ms: 40,
  },
  {
    type: "tool",
    kind: "edit",
    name: "Edit",
    summary: "/work/demo/src/app.ts",
    diff: "-42\n+43",
    output: "The file /work/demo/src/app.ts has been updated.",
    status: "done",
  },
  {
    type: "tool",
    kind: "edit",
    name: "MultiEdit",
    summary: "/work/demo/src/util.ts",
    diff: "-let a = 1;\n+const a = 1;\n-foo()\n-bar()\n+baz()",
    output: "Applied 2 edits to /work/demo/src/util.ts",
    status: "done",
  },
  {
    type: "tool",
    kind: "edit",
    name: "Write",
    summary: "/work/demo/NOTES.md",
    diff: "+# Notes\n+\n+The answer is 43.",
    output: "File created successfully at: /work/demo/NOTES.md",
    status: "done",
  },
  {
    type: "tool",
    kind: "edit",
    name: "NotebookEdit",
    summary: "/work/demo/nb.ipynb",
    diff: "+print(43)",
    output: "Updated cell c1 with print(43)",
    status: "done",
  },
  {
    type: "tool",
    kind: "search",
    name: "Grep",
    summary: "answer",
    output: "src/app.ts:1:export const answer = 43;",
    status: "done",
    duration_ms: 250,
  },
  {
    type: "tool",
    kind: "other",
    name: "Agent",
    summary: "Review the change",
    output: "The change looks correct.",
    status: "done",
    duration_ms: 2000,
  },
  { type: "text", text: "The review passed, so I will report back." },
  {
    type: "tool",
    kind: "message",
    name: "send_message",
    summary: "Done: the answer is now 43.",
    output: '{"status":"sent"}',
    status: "done",
    duration_ms: 120,
  },
  {
    type: "tool",
    kind: "web",
    name: "WebFetch",
    summary: "https://example.com/changelog",
    status: "running",
  },
  { type: "error", text: "Execution stopped: usage limit reached" },
];

test("readTranscript turns a Claude Code log into the expected steps", () => {
  assert.deepEqual(readTranscript(fixture), FIXTURE_STEPS);
});

test("engine.transcript reads the log at params.log_path", async () => {
  const req = {
    protocol_version: 1,
    method: "transcript",
    openbee_version: "test",
    engine_id: "claude",
    language: "en",
    config: {},
    data_dir: "",
    state_dir: "",
    params: { log_path: fixture },
  };
  assert.deepEqual(await engine.transcript(req), FIXTURE_STEPS);
});

test("readTranscript returns no steps for a missing log", () => {
  assert.deepEqual(readTranscript(join(scratch, "missing.jsonl")), []);
});

test("readTranscript classifies tools and picks their summaries", () => {
  const cases = [
    ["Bash", { command: "ls -la", description: "List" }, "command", "ls -la"],
    ["BashOutput", { command: "tail -n 5 out.log" }, "command", "tail -n 5 out.log"],
    ["Read", { file_path: "/a/b.txt", limit: 10 }, "read", "/a/b.txt"],
    ["NotebookRead", { notebook_path: "/a/n.ipynb" }, "read", "/a/n.ipynb"],
    ["NotebookRead", { file_path: "/a/legacy.ipynb" }, "read", "/a/legacy.ipynb"],
    ["NotebookRead", { notebook_path: "/a/n.ipynb", file_path: "/a/other.ipynb" }, "read", "/a/n.ipynb"],
    ["NotebookRead", {}, "read", undefined],
    ["Read", {}, "read", undefined],
    ["Write", { file_path: "/a/w.txt", content: "x" }, "edit", "/a/w.txt"],
    ["Edit", { file_path: "/a/e.txt", old_string: "a", new_string: "b" }, "edit", "/a/e.txt"],
    ["MultiEdit", { file_path: "/a/m.txt", edits: [] }, "edit", "/a/m.txt"],
    ["NotebookEdit", { notebook_path: "/a/n.ipynb", cell_id: "c1", new_source: "x", edit_mode: "replace" }, "edit", "/a/n.ipynb"],
    ["NotebookEdit", { file_path: "/a/legacy.ipynb", new_source: "x" }, "edit", "/a/legacy.ipynb"],
    ["Grep", { pattern: "foo.*bar", path: "/a" }, "search", "foo.*bar"],
    ["Glob", { pattern: "**/*.ts" }, "search", "**/*.ts"],
    ["WebFetch", { url: "https://example.com", prompt: "p" }, "web", "https://example.com"],
    ["WebSearch", { query: "release notes", mode: "fast" }, "web", "release notes"],
    ["mcp__openbee__send_message", { message_id: "m1", content: "hello" }, "message", "hello"],
    ["mcp__other__send_message", { media_path: "/a/b.png" }, "message", undefined],
    ["mcp__openbee__execute", { code: "return 1;" }, "other", "return 1;"],
    ["Skill", { skill: "pdf" }, "other", "pdf"],
    ["ToolSearch", { max_results: 5, query: "slack" }, "other", "slack"],
    ["TaskStop", { limit: 1 }, "other", undefined],
    ["SendMessage", { to: "peer", message: "hi" }, "other", "peer"],
    ["constructor", { value: "x" }, "other", "x"],
  ];
  const path = writeLog(cases.map(([name, input], index) => toolUse(`t${index}`, name, input)));
  const steps = readTranscript(path);
  assert.equal(steps.length, cases.length);
  cases.forEach(([name, , kind, summary], index) => {
    const step = steps[index];
    assert.equal(step.type, "tool", name);
    assert.equal(step.kind, kind, name);
    assert.equal(step.name, name.replace(/^mcp__.+?__/, ""), name);
    assert.equal(step.summary, summary, name);
    assert.equal(step.status, "running", name);
  });
});

function diffOf(name, input) {
  const [step] = readTranscript(writeLog([toolUse("d", name, input)]));
  return step.diff;
}

test("readTranscript builds an Edit diff with removed lines before added lines", () => {
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "one\ntwo", new_string: "uno\ndos\ntres" }), "-one\n-two\n+uno\n+dos\n+tres");
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "x", new_string: "y", replace_all: true }), "-x\n+y");
});

test("readTranscript skips the empty side of an Edit", () => {
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "", new_string: "added" }), "+added");
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "gone", new_string: "" }), "-gone");
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "", new_string: "" }), undefined);
  assert.equal(diffOf("Edit", { file_path: "/a" }), undefined);
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: 1, new_string: null }), undefined);
});

test("readTranscript drops one trailing newline and keeps inner blank lines", () => {
  assert.equal(diffOf("Edit", { file_path: "/a", old_string: "a\n\nb\n", new_string: "c\r\nd\r\n" }), "-a\n-\n-b\n+c\n+d");
  assert.equal(diffOf("Write", { file_path: "/a", content: "x\n\n" }), "+x\n+");
});

test("readTranscript builds a MultiEdit diff from every valid edit in order", () => {
  const edits = [
    { old_string: "a", new_string: "b" },
    "junk",
    null,
    { old_string: 3 },
    { old_string: "", new_string: "c" },
    { old_string: "d", new_string: "" },
  ];
  assert.equal(diffOf("MultiEdit", { file_path: "/a", edits }), "-a\n+b\n+c\n-d");
  assert.equal(diffOf("MultiEdit", { file_path: "/a", edits: [] }), undefined);
  assert.equal(diffOf("MultiEdit", { file_path: "/a", edits: "nope" }), undefined);
  assert.equal(diffOf("MultiEdit", { file_path: "/a" }), undefined);
});

test("readTranscript builds a Write diff from the content", () => {
  assert.equal(diffOf("Write", { file_path: "/a", content: "one\ntwo" }), "+one\n+two");
  assert.equal(diffOf("Write", { file_path: "/a", content: "" }), undefined);
  assert.equal(diffOf("Write", { file_path: "/a", content: 5 }), undefined);
  assert.equal(diffOf("Write", { file_path: "/a" }), undefined);
});

test("readTranscript builds a NotebookEdit diff from the new source", () => {
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", new_source: "x = 1\ny = 2", edit_mode: "insert" }), "+x = 1\n+y = 2");
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", cell_id: "c1", edit_mode: "delete" }), undefined);
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", cell_id: "c1", new_source: "x = 1", edit_mode: "delete" }), undefined);
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", cell_id: "c1", new_source: "x = 1", edit_mode: "replace" }), "+x = 1");
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", cell_id: "c1", new_source: "x = 1" }), "+x = 1");
  assert.equal(diffOf("NotebookEdit", { notebook_path: "/a.ipynb", new_source: "" }), undefined);
});

test("readTranscript gives no diff to other tools", () => {
  assert.equal(diffOf("Bash", { command: "ls", old_string: "a", new_string: "b", content: "c" }), undefined);
  assert.equal(diffOf("Read", { file_path: "/a", content: "c" }), undefined);
  assert.equal(diffOf("mcp__x__Edit", { old_string: "a", new_string: "b" }), undefined);
});

test("readTranscript clips a long diff on line boundaries", () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const diff = diffOf("Write", { file_path: "/a", content });
  assert.ok(diff.length <= 4000);
  assert.ok(diff.startsWith("+line 0\n+line 1\n"));
  assert.ok(diff.endsWith("\n+line 999"));
  const lines = diff.split("\n");
  assert.equal(lines.filter((line) => line === "…").length, 1);
  for (const line of lines) {
    assert.ok(line === "…" || /^\+line \d+$/.test(line), line);
  }
});

test("readTranscript skips nested lines and unrelated events", () => {
  const nested = { ...toolUse("n1", "Bash", { command: "ls" }), parent_tool_use_id: "toolu_parent" };
  const path = writeLog([
    nested,
    { type: "system", subtype: "init" },
    { type: "rate_limit_event" },
    { type: "tool_progress", tool_use_id: "n1", parent_tool_use_id: "toolu_parent" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "x" }] }, parent_tool_use_id: "toolu_parent" },
    { type: "result", subtype: "success", is_error: false, result: "all good" },
  ]);
  assert.deepEqual(readTranscript(path), []);
});

test("readTranscript reports an error result and falls back to the subtype", () => {
  const withText = writeLog([{ type: "result", subtype: "error_max_turns", is_error: true, result: "Too many turns" }]);
  assert.deepEqual(readTranscript(withText), [{ type: "error", text: "Too many turns" }]);
  const withoutText = writeLog([{ type: "result", subtype: "error_during_execution", is_error: true, result: "" }]);
  assert.deepEqual(readTranscript(withoutText), [{ type: "error", text: "error_during_execution" }]);
});

test("readTranscript ignores tool results it cannot match and non-text result blocks", () => {
  const path = writeLog([
    toolUse("a", "Bash", { command: "ls" }),
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "unknown", content: "ignored" },
          { type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: {} }, { type: "text", text: "one" }, { type: "text", text: "two" }] },
        ],
      },
      parent_tool_use_id: null,
      timestamp: "not a date",
    },
  ]);
  assert.deepEqual(readTranscript(path), [
    { type: "tool", kind: "command", name: "Bash", summary: "ls", output: "one\ntwo", status: "done" },
  ]);
});
