import { TranscriptBuilder, readJsonLines, stripMcpPrefix } from "@theopenbee/engine-sdk";
import type { ToolKind, TranscriptStep } from "@theopenbee/engine-sdk";

type JsonObject = Record<string, unknown>;

const KIND_RULES = new Map<string, [ToolKind, string[]]>([
  ["Bash", ["command", ["command"]]],
  ["BashOutput", ["command", ["command"]]],
  ["Read", ["read", ["file_path"]]],
  ["NotebookRead", ["read", ["notebook_path", "file_path"]]],
  ["Write", ["edit", ["file_path"]]],
  ["Edit", ["edit", ["file_path"]]],
  ["MultiEdit", ["edit", ["file_path"]]],
  ["NotebookEdit", ["edit", ["notebook_path", "file_path"]]],
  ["Grep", ["search", ["pattern"]]],
  ["Glob", ["search", ["pattern"]]],
  ["WebFetch", ["web", ["url"]]],
  ["WebSearch", ["web", ["query"]]],
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstString(input: JsonObject): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function diffLines(text: unknown, marker: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => marker + line);
}

function replaceLines(oldText: unknown, newText: unknown): string[] {
  return [...diffLines(oldText, "-"), ...diffLines(newText, "+")];
}

function buildDiff(name: string, input: JsonObject): string | undefined {
  let lines: string[] = [];
  if (name === "Edit") {
    lines = replaceLines(input.old_string, input.new_string);
  } else if (name === "MultiEdit") {
    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        if (isObject(edit)) lines.push(...replaceLines(edit.old_string, edit.new_string));
      }
    }
  } else if (name === "Write") {
    lines = diffLines(input.content, "+");
  } else if (name === "NotebookEdit") {
    if (input.edit_mode !== "delete") lines = diffLines(input.new_source, "+");
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function describeTool(name: string, input: JsonObject): { kind: ToolKind; summary?: string; diff?: string } {
  const rule = KIND_RULES.get(name);
  if (rule) return { kind: rule[0], summary: stringField(input, rule[1]), diff: buildDiff(name, input) };
  if (name.endsWith("send_message")) return { kind: "message", summary: stringField(input, ["content"]) };
  return { kind: "other", summary: firstString(input) };
}

function contentBlocks(event: JsonObject): JsonObject[] {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObject);
}

function timestampOf(event: JsonObject): number | undefined {
  return typeof event.timestamp === "string" ? Date.parse(event.timestamp) : undefined;
}

function resultOutput(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function addAssistant(builder: TranscriptBuilder, event: JsonObject): void {
  const at = timestampOf(event);
  for (const block of contentBlocks(event)) {
    if (block.type === "text" && typeof block.text === "string") {
      builder.text(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      builder.thinking(block.thinking);
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const { kind, summary, diff } = describeTool(block.name, isObject(block.input) ? block.input : {});
      builder.toolStart(block.id, { kind, name: stripMcpPrefix(block.name), summary, diff }, at);
    }
  }
}

function addUser(builder: TranscriptBuilder, event: JsonObject): void {
  const at = timestampOf(event);
  for (const block of contentBlocks(event)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      builder.toolEnd(block.tool_use_id, { output: resultOutput(block.content), isError: block.is_error === true }, at);
    }
  }
}

function addResult(builder: TranscriptBuilder, event: JsonObject): void {
  if (event.is_error !== true) return;
  const text = typeof event.result === "string" && event.result !== "" ? event.result : event.subtype;
  if (typeof text === "string" && text !== "") builder.error(text);
}

export function readTranscript(logPath: string): TranscriptStep[] {
  const builder = new TranscriptBuilder();
  for (const event of readJsonLines(logPath)) {
    if (typeof event.parent_tool_use_id === "string") continue;
    if (event.type === "assistant") addAssistant(builder, event);
    else if (event.type === "user") addUser(builder, event);
    else if (event.type === "result") addResult(builder, event);
  }
  return builder.steps();
}
