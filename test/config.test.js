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

test("审批模式默认 auto 并支持别名", () => {
  assert.equal(loadConfig(base).approvalMode, "auto");
  assert.equal(loadConfig({ ...base, CODEARTS_APPROVAL_MODE: "manual" }).approvalMode, "manual");
  assert.equal(loadConfig({ ...base, CODEARTS_APPROVAL_MODE: "full_access" }).approvalMode, "full");
  assert.equal(
    loadConfig({ ...base, CODEARTS_APPROVAL_MODE: "AUTO_APPROVAL" }).approvalMode,
    "auto",
  );
});

test("非法审批模式直接报错", () => {
  assert.throws(
    () => loadConfig({ ...base, CODEARTS_APPROVAL_MODE: "yolo" }),
    /CODEARTS_APPROVAL_MODE/,
  );
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

test("群内按人隔离默认开启", () => {
  assert.equal(loadConfig(base).groupSessionsPerUser, true);
  assert.equal(loadConfig({ ...base, GROUP_SESSIONS_PER_USER: "false" }).groupSessionsPerUser, false);
});

test("用户白名单按逗号拆分", () => {
  const config = loadConfig({ ...base, ALLOWED_USER_IDS: "ou_1, ou_2" });
  assert.deepEqual(config.allowedUserIds, ["ou_1", "ou_2"]);
});

test("群策略默认 open 且校验取值", () => {
  assert.equal(loadConfig(base).groupPolicy, "open");
  assert.equal(loadConfig({ ...base, GROUP_POLICY: "ALLOWLIST" }).groupPolicy, "allowlist");
  assert.throws(() => loadConfig({ ...base, GROUP_POLICY: "closed" }), /GROUP_POLICY/);
});

test("按群规则可解析并校验", () => {
  const config = loadConfig({
    ...base,
    GROUP_RULES: JSON.stringify({
      oc_1: { policy: "allowlist", allowlist: ["ou_1"], requireMention: false },
    }),
  });
  assert.equal(config.groupRules.oc_1.policy, "allowlist");
  assert.deepEqual(config.groupRules.oc_1.allowlist, ["ou_1"]);
  assert.equal(config.groupRules.oc_1.requireMention, false);

  assert.throws(() => loadConfig({ ...base, GROUP_RULES: "{broken" }), /GROUP_RULES/);
  assert.throws(
    () => loadConfig({ ...base, GROUP_RULES: JSON.stringify({ oc_1: { policy: "closed" } }) }),
    /GROUP_RULES/,
  );
});

test("批处理与去重默认值", () => {
  const config = loadConfig(base);
  assert.equal(config.textBatchDelayMs, 600);
  assert.equal(config.textBatchMaxMessages, 8);
  assert.equal(config.textBatchMaxChars, 4000);
  assert.equal(config.dedupMax, 2048);
  assert.equal(config.dedupTtlMs, 86400000);
  assert.equal(config.reactions, true);
});