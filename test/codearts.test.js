import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEventLine, buildArgs, runCodearts, summarizeResult } from "../src/codearts.js";

function fakeBinary(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-codearts-"));
  const file = path.join(dir, "fake-codearts");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("解析文本事件", () => {
  const parsed = parseEventLine(
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"你好"}}',
  );
  assert.equal(parsed.sessionID, "ses_1");
  assert.equal(parsed.chunk, "你好");
  assert.equal(parsed.error, "");
});

test("解析工具事件时不产生文本", () => {
  const parsed = parseEventLine(
    '{"type":"text","part":{"type":"tool","tool":"bash"}}',
  );
  assert.equal(parsed.chunk, "");
});

test("解析错误事件", () => {
  const parsed = parseEventLine('{"type":"error","error":{"message":"模型不可用"}}');
  assert.equal(parsed.error, "模型不可用");
});

test("忽略非 JSON 行", () => {
  assert.equal(parseEventLine("plain text"), null);
  assert.equal(parseEventLine(""), null);
  assert.equal(parseEventLine("{broken"), null);
});

test("构造参数包含非交互与 JSON 输出", () => {
  assert.deepEqual(buildArgs({}), ["run", "--format", "json", "--auto_approval"]);
  assert.deepEqual(buildArgs({ sessionId: "ses_1", model: "m", agent: "a" }), [
    "run",
    "--format",
    "json",
    "--auto_approval",
    "--session",
    "ses_1",
    "--model",
    "m",
    "--agent",
    "a",
  ]);
});

test("运行并汇总多个文本事件", async () => {
  const bin = fakeBinary(
    [
      "echo '{\"type\":\"text\",\"sessionID\":\"ses_9\",\"part\":{\"type\":\"text\",\"text\":\"hello \"}}'",
      "echo '{\"type\":\"text\",\"sessionID\":\"ses_9\",\"part\":{\"type\":\"text\",\"text\":\"world\"}}'",
    ].join("\n"),
  );

  const result = await runCodearts({ bin, prompt: "hi", cwd: "/tmp" });
  assert.equal(result.text, "hello world");
  assert.equal(result.sessionID, "ses_9");
  assert.equal(result.exitCode, 0);
});

test("非零退出时回退到 stderr", async () => {
  const bin = fakeBinary("echo 'something broke' >&2\nexit 3");
  const result = await runCodearts({ bin, prompt: "hi", cwd: "/tmp" });
  assert.equal(result.exitCode, 3);
  assert.match(summarizeResult(result), /something broke/);
});

test("错误事件优先于 stderr", async () => {
  const bin = fakeBinary(
    "echo '{\"type\":\"error\",\"error\":{\"message\":\"boom\"}}'\necho 'stderr text' >&2\nexit 0",
  );
  const result = await runCodearts({ bin, prompt: "hi", cwd: "/tmp" });
  assert.match(summarizeResult(result), /boom/);
});

test("abort 会终止子进程", async () => {
  const bin = fakeBinary("sleep 5");
  const controller = new AbortController();
  const run = runCodearts({ bin, prompt: "hi", cwd: "/tmp", signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await run;
  assert.equal(result.aborted, true);
  assert.match(summarizeResult(result), /已停止/);
});

test("超时会终止子进程", async () => {
  const bin = fakeBinary("sleep 5");
  const result = await runCodearts({ bin, prompt: "hi", cwd: "/tmp", timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.match(summarizeResult(result), /超时/);
});

test("无法启动时返回 spawnError", async () => {
  const result = await runCodearts({ bin: "/nonexistent/codearts", prompt: "hi", cwd: "/tmp" });
  assert.ok(result.spawnError);
  assert.match(summarizeResult(result), /启动 codearts 失败/);
});

test("空输出时给出退出码提示", async () => {
  const bin = fakeBinary("exit 0");
  const result = await runCodearts({ bin, prompt: "hi", cwd: "/tmp" });
  assert.match(summarizeResult(result), /退出码 0/);
});