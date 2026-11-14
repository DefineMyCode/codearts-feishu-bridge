import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const base = { CODEARTS_WORKDIR: "/tmp/demo" };

test("默认使用卡片回复", () => {
  const config = loadConfig(base);
  assert.equal(config.replyFormat, "card");
  assert.equal(config.larkIdentity, "bot");
  assert.equal(config.replyChunkSize, 1800);
  assert.equal(config.maxConcurrency, 2);
  assert.equal(config.requireMentionInGroup, true);
});

test("REPLY_FORMAT 支持 post 与 text 且忽略大小写", () => {
  assert.equal(loadConfig({ ...base, REPLY_FORMAT: "POST" }).replyFormat, "post");
  assert.equal(loadConfig({ ...base, REPLY_FORMAT: "Text" }).replyFormat, "text");
});

test("非法 REPLY_FORMAT 直接报错", () => {
  assert.throws(() => loadConfig({ ...base, REPLY_FORMAT: "cardx" }), /REPLY_FORMAT/);
});

test("缺少 CODEARTS_WORKDIR 时报错", () => {
  assert.throws(() => loadConfig({}), /CODEARTS_WORKDIR/);
});

test("白名单按逗号拆分并去掉空项", () => {
  const config = loadConfig({ ...base, ALLOWED_CHAT_IDS: "oc_1, ,oc_2," });
  assert.deepEqual(config.allowedChatIds, ["oc_1", "oc_2"]);
});

test("布尔开关可关闭", () => {
  const config = loadConfig({ ...base, GROUP_REQUIRE_MENTION: "false", BRIDGE_ACK: "off" });
  assert.equal(config.requireMentionInGroup, false);
  assert.equal(config.ack, false);
});