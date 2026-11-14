import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEvent,
  renderMentions,
  isAddressedToBot,
  parseCommand,
  Deduper,
} from "../src/message.js";

function p2pEvent(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    chat_id: "oc_1",
    chat_type: "p2p",
    message_id: "om_1",
    message_type: "text",
    content: "帮我看看代码",
    sender_type: "user",
    sender_id: "ou_1",
    mentions: [],
    ...overrides,
  };
}

test("渲染 @ 占位符为用户名", () => {
  const text = renderMentions("@_user_1 请执行", [{ key: "@_user_1", name: "码道" }]);
  assert.equal(text, "@码道 请执行");
});

test("缺少 mention 名字时直接移除占位符", () => {
  assert.equal(renderMentions("@_user_1 你好", [{ key: "@_user_1" }]), "你好");
});

test("归一化私聊文本消息", () => {
  const message = normalizeEvent(p2pEvent());
  assert.equal(message.chatId, "oc_1");
  assert.equal(message.messageId, "om_1");
  assert.equal(message.chatType, "p2p");
  assert.equal(message.text, "帮我看看代码");
});

test("非消息事件被忽略", () => {
  assert.equal(normalizeEvent({ type: "im.chat.updated_v1" }), null);
  assert.equal(normalizeEvent(null), null);
});

test("机器人自己发来的消息被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ sender_type: "bot" })), null);
});

test("非文本消息被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ message_type: "image", content: "" })), null);
});

test("缺少会话或消息 ID 被忽略", () => {
  assert.equal(normalizeEvent(p2pEvent({ chat_id: "" })), null);
  assert.equal(normalizeEvent(p2pEvent({ message_id: "", id: "" })), null);
});

test("兼容旧字段 id", () => {
  const message = normalizeEvent(p2pEvent({ message_id: "", id: "om_legacy" }));
  assert.equal(message.messageId, "om_legacy");
});

test("私聊消息总是响应", () => {
  const message = normalizeEvent(p2pEvent());
  assert.equal(isAddressedToBot(message, { requireMention: true }), true);
});

test("群聊未 @ 机器人时忽略", () => {
  const message = normalizeEvent(p2pEvent({ chat_type: "group", mentions: [] }));
  assert.equal(isAddressedToBot(message, { requireMention: true }), false);
  assert.equal(isAddressedToBot(message, { requireMention: false }), true);
});

test("群聊按机器人名称匹配 mention", () => {
  const message = normalizeEvent(
    p2pEvent({ chat_type: "group", content: "@_user_1 跑测试", mentions: [{ key: "@_user_1", name: "码道" }] }),
  );
  assert.equal(isAddressedToBot(message, { botName: "码道" }), true);
  assert.equal(isAddressedToBot(message, { botName: "其他机器人" }), false);
});

test("解析已知斜杠命令", () => {
  assert.deepEqual(parseCommand("/new"), { command: "/new", args: "" });
  assert.deepEqual(parseCommand("/status now"), { command: "/status", args: "now" });
  assert.deepEqual(parseCommand("/HELP"), { command: "/help", args: "" });
});

test("普通文本与未知斜杠命令不被识别为命令", () => {
  assert.equal(parseCommand("你好"), null);
  assert.equal(parseCommand("/unknown"), null);
});

test("去重器按容量淘汰旧键", () => {
  const deduper = new Deduper(2);
  assert.equal(deduper.check("a"), true);
  assert.equal(deduper.check("a"), false);
  assert.equal(deduper.check("b"), true);
  assert.equal(deduper.check("c"), true);
  assert.equal(deduper.check("a"), true);
});

test("空键视为新消息", () => {
  const deduper = new Deduper(2);
  assert.equal(deduper.check(""), true);
  assert.equal(deduper.check(""), true);
});