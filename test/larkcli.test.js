import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildConsumeArgs,
  buildReplyArgs,
  buildReplyCardArgs,
  buildSendArgs,
  createNdjsonDecoder,
  LarkCli,
} from "../src/larkcli.js";

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

test("构造事件消费、回复与发送命令", () => {
  assert.deepEqual(buildConsumeArgs({ eventKey: "im.message.receive_v1", identity: "bot" }), [
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot",
    "--quiet",
  ]);
  assert.deepEqual(buildReplyArgs({ messageId: "om_1", text: "hi", identity: "bot" }), [
    "im",
    "+messages-reply",
    "--message-id",
    "om_1",
    "--markdown",
    "hi",
    "--as",
    "bot",
  ]);
  assert.deepEqual(
    buildReplyArgs({ messageId: "om_1", text: "hi", identity: "bot", markdown: false }),
    ["im", "+messages-reply", "--message-id", "om_1", "--text", "hi", "--as", "bot"],
  );
  assert.deepEqual(buildSendArgs({ chatId: "oc_1", text: "hi", identity: "bot" }), [
    "im",
    "+messages-send",
    "--chat-id",
    "oc_1",
    "--text",
    "hi",
    "--as",
    "bot",
  ]);
  assert.deepEqual(
    buildReplyCardArgs({ messageId: "om_1", card: '{"a":1}', identity: "bot" }),
    [
      "im",
      "+messages-reply",
      "--message-id",
      "om_1",
      "--content",
      '{"a":1}',
      "--msg-type",
      "interactive",
      "--as",
      "bot",
    ],
  );
});

test("NDJSON 解码器支持跨块与坏行", () => {
  const events = [];
  const bad = [];
  const decoder = createNdjsonDecoder((obj) => events.push(obj), (line) => bad.push(line));
  decoder.push('{"a":1}\nnot json\n{"b"');
  decoder.push(':2}\n');
  decoder.flush();
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(bad, ["not json"]);
});

test("replyText 使用纯文本参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const result = await cli.replyText("om_1", "hello");
  assert.equal(result.code, 0);
  assert.equal(calls[0].bin, "lark-cli");
  assert.deepEqual(
    calls[0].args,
    buildReplyArgs({ messageId: "om_1", text: "hello", markdown: false }),
  );
});

test("replyMarkdown 使用 markdown 参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const result = await cli.replyMarkdown("om_1", "**hello**");
  assert.equal(result.code, 0);
  assert.ok(calls[0].args.includes("--markdown"));
  assert.ok(!calls[0].args.includes("--text"));
  assert.deepEqual(calls[0].args, buildReplyArgs({ messageId: "om_1", text: "**hello**" }));
});

test("replyCard 使用 interactive 卡片参数", async () => {
  const calls = [];
  const cli = new LarkCli({
    spawnImpl: (bin, args) => {
      calls.push({ bin, args });
      return fakeChild({ code: 0, stdout: "{}" });
    },
  });
  const card = '{"elements":[]}';
  const result = await cli.replyCard("om_1", card);
  assert.equal(result.code, 0);
  assert.deepEqual(
    calls[0].args,
    buildReplyCardArgs({ messageId: "om_1", card }),
  );
  assert.ok(calls[0].args.includes("--msg-type"));
  assert.ok(calls[0].args.includes("interactive"));
  assert.ok(!calls[0].args.includes("--markdown"));
});

test("version 在成功时返回版本号", async () => {
  const cli = new LarkCli({ spawnImpl: () => fakeChild({ code: 0, stdout: "1.0.84\n" }) });
  assert.equal(await cli.version(), "1.0.84");
});

test("status 在未配置时返回 ok=false", async () => {
  const cli = new LarkCli({ spawnImpl: () => fakeChild({ code: 1, stderr: "not configured" }) });
  const result = await cli.status();
  assert.equal(result.ok, false);
  assert.match(result.detail, /not configured/);
});

test("startConsuming 把 stdout 行解析为事件，stop 后不再重连", async () => {
  let spawnCount = 0;
  const events = [];
  const cli = new LarkCli({
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild({ code: 0, stdout: '{"type":"im.message.receive_v1","message_id":"om_1"}\n' });
    },
  });
  const consumer = cli.startConsuming({ onEvent: (event) => events.push(event) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, "om_1");

  consumer.stop();
  const countAtStop = spawnCount;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(spawnCount, countAtStop);
});