import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("manifest describes the claude engine", () => {
  assert.deepEqual(readJson("openbee.plugin.json"), {
    protocol_version: 1,
    type: "engine",
    id: "claude",
    name: { en: "Claude Code", zh: "Claude Code" },
    description: { en: "Runs tasks with Claude Code", zh: "用 Claude Code 执行任务" },
    command: ["node", "dist/index.js"],
    config: [
      {
        key: "path",
        type: "string",
        label: { en: "Claude Code path", zh: "Claude Code 路径" },
        help: { en: "Leave empty to use claude on PATH", zh: "留空则使用 PATH 里的 claude" },
      },
    ],
  });
});

test("package.json publishes dist and the manifest", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@theopenbee/engine-claude");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist", "openbee.plugin.json"]);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.equal(pkg.dependencies["@theopenbee/engine-sdk"], "^0.1.0");
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
});

test("the build output exists", () => {
  assert.ok(existsSync(join(root, "dist", "index.js")));
  assert.ok(existsSync(join(root, "dist", "claude.js")));
});
