import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMessageHandler } from "../src/handler.js";
import { SessionStore } from "../src/sessions.js";
import { TaskQueue } from "../src/queue.js";

function makeConfig(overrides = {}) {
  return {
    codeartsBin: "codearts",
    workdir: os.tmpdir(),
    model: "",
    agent: "",
    timeoutMs: 60000,
    replyFormat: "card",
    replyChunkSize: 1800,
    replyMaxChunks: 4,
    ack: true,
    allowedChatIds: [],
    requireMentionInGroup: true,
    botName: "",
    ...overrides,
  };
}

function makeHarness({ config = makeConfig(), runCodearts } = {}) {
  const replies = [];
  const lark = {
    replyCard: async (messageId, card) => {
      const parsed = JSON.parse(card);
      replies.push({
        messageId,
        card,
        text: parsed.elements?.[0]?.content ?? "",
        mode: "card",
      });
      return { code: 0 };
    },
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 0 };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const sessions = new SessionStore(file).load();
  const queue = new TaskQueue({ maxConcurrency: 2 });
  const errors = [];
  const handle = createMessageHandler({
    config,
    sessions,
    queue,
    lark,
    logger: { error: (...args) => errors.push(args), debug: () => {} },
    runCodearts: runCodearts || (async () => ({ text: "done", sessionID: "ses_new", exitCode: 0 })),
  });
  return { handle, replies, sessions, queue, errors };
}

function event(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    chat_id: "oc_1",
    chat_type: "p2p",
    message_id: "om_1",
    message_type: "text",
    sender_type: "user",
    content: "修个 bug",
    mentions: [],
    ...overrides,
  };
}

test("私聊消息先确认再回复结果并保存会话", async () => {
  const { handle, replies, sessions } = makeHarness();
  const result = await handle(event());
  assert.equal(result.status, "started");
  await result.run;

  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /已收到/);
  assert.equal(replies[1].text, "done");
  assert.equal(sessions.get("oc_1"), "ses_new");
});

test("关闭确认后可只回结果", async () => {
  const { handle, replies } = makeHarness({ config: makeConfig({ ack: false }) });
  await (await handle(event())).run;
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "done");
});

test("/help 与 /status 直接回复", async () => {
  const { handle, replies } = makeHarness();
  const help = await handle(event({ message_id: "om_help", content: "/help" }));
  assert.equal(help.status, "command");
  assert.match(replies[0].text, /\/new/);

  const status = await handle(event({ message_id: "om_status", content: "/status" }));
  assert.equal(status.status, "command");
  assert.match(replies[1].text, /空闲/);
});

test("/new 清除会话上下文", async () => {
  const { handle, sessions } = makeHarness();
  sessions.set("oc_1", "ses_old");
  await handle(event({ message_id: "om_new", content: "/new" }));
  assert.equal(sessions.get("oc_1"), "");
});

test("群聊未 @ 机器人不响应", async () => {
  const { handle, replies } = makeHarness();
  const result = await handle(event({ chat_type: "group", mentions: [] }));
  assert.equal(result.status, "not-addressed");
  assert.equal(replies.length, 0);
});

test("白名单外会话被忽略", async () => {
  const { handle, replies } = makeHarness({ config: makeConfig({ allowedChatIds: ["oc_other"] }) });
  const result = await handle(event());
  assert.equal(result.status, "blocked");
  assert.equal(replies.length, 0);
});

test("重复消息只处理一次", async () => {
  const { handle, replies } = makeHarness();
  await (await handle(event())).run;
  const again = await handle(event());
  assert.equal(again.status, "duplicate");
  assert.equal(replies.length, 2);
});

test("同一会话执行中再次发言会提示", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handle, replies } = makeHarness({
    runCodearts: async () => {
      await gate;
      return { text: "done", sessionID: "ses_1" };
    },
  });

  const first = await handle(event({ message_id: "om_a" }));
  await handle(event({ message_id: "om_b" }));
  release();
  await first.run;
  assert.ok(replies.some((r) => /上一个任务还在执行/.test(r.text)));
});

test("/stop 中止正在执行的任务", async () => {
  let aborted = false;
  const { handle, replies } = makeHarness({
    runCodearts: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ text: "stopped", aborted: true });
        });
      }),
  });

  const first = await handle(event({ message_id: "om_run" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await handle(event({ message_id: "om_stop", content: "/stop" }));
  await first.run;

  assert.equal(aborted, true);
  assert.ok(replies.some((r) => /已发送停止信号/.test(r.text)));
  assert.ok(replies.some((r) => /已停止当前任务/.test(r.text)));
});

test("码道启动失败时回复错误摘要", async () => {
  const { handle, replies } = makeHarness({
    runCodearts: async () => ({ spawnError: "ENOENT", text: "" }),
  });
  await (await handle(event())).run;
  assert.match(replies.at(-1).text, /启动 codearts 失败/);
});

test("Markdown 回复失败时自动回退纯文本", async () => {
  const replies = [];
  const lark = {
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 1, stderr: "markdown not supported" };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig(),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runCodearts: async () => ({ text: "done", sessionID: "ses_fallback" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(replies.map((r) => r.mode), ["markdown", "text", "markdown", "text"]);
  assert.equal(replies.at(-1).text, "done");
});

test("卡片失败时依次回退 Markdown 与纯文本", async () => {
  const replies = [];
  const lark = {
    replyCard: async (messageId, card) => {
      replies.push({ messageId, card, mode: "card" });
      return { code: 1, stderr: "card rejected" };
    },
    replyMarkdown: async (messageId, text) => {
      replies.push({ messageId, text, mode: "markdown" });
      return { code: 1, stderr: "markdown rejected" };
    },
    replyText: async (messageId, text) => {
      replies.push({ messageId, text, mode: "text" });
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig({ replyFormat: "card" }),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runCodearts: async () => ({ text: "done", sessionID: "ses_card" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(replies.map((r) => r.mode), [
    "card",
    "markdown",
    "text",
    "card",
    "markdown",
    "text",
  ]);
  assert.equal(replies.at(-1).text, "done");
});

test("REPLY_FORMAT=text 时不尝试卡片与 Markdown", async () => {
  const modes = [];
  const lark = {
    replyCard: async () => {
      modes.push("card");
      return { code: 0 };
    },
    replyMarkdown: async () => {
      modes.push("markdown");
      return { code: 0 };
    },
    replyText: async () => {
      modes.push("text");
      return { code: 0 };
    },
  };
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "handler-")), "sessions.json");
  const handle = createMessageHandler({
    config: makeConfig({ replyFormat: "text", ack: false }),
    sessions: new SessionStore(stateFile).load(),
    queue: new TaskQueue({ maxConcurrency: 1 }),
    lark,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    runCodearts: async () => ({ text: "done", sessionID: "ses_text" }),
  });

  await (await handle(event())).run;
  assert.deepEqual(modes, ["text"]);
});