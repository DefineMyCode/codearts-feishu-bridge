import {
  normalizeEvent,
  isAddressedToBot,
  parseCommand,
  Deduper,
} from "./message.js";
import { buildSessionKey } from "./sessions.js";
import { chunkText } from "./text.js";
import { summarizeResult } from "./codearts.js";
import { buildCardMarkdown } from "./card.js";

const HELP_TEXT = [
  "码道飞书桥接命令：",
  "/help   显示本帮助",
  "/new    结束当前会话上下文，下一条消息开启新会话",
  "/stop   终止当前正在执行的任务",
  "/status 查看当前会话与任务状态",
  "",
  "直接发送文本即会把任务交给码道执行；群聊中需要 @机器人。",
].join("\n");

export function createMessageHandler({
  config,
  sessions,
  queue,
  lark,
  logger,
  runCodearts,
  deduper,
  batcher,
}) {
  const seen = deduper || new Deduper(500);
  const perUser = config.groupSessionsPerUser !== false;
  const rules = config.groupRules || {};
  const allowedUserIds = config.allowedUserIds || [];
  const globalPolicy = config.groupPolicy || "open";
  const reactionsEnabled = config.reactions !== false;
  const running = new Map();

  function sessionKeyFor(message) {
    return buildSessionKey({
      chatId: message.chatId,
      senderId: message.senderId,
      chatType: message.chatType,
      perUser,
    });
  }

  function sessionFor(message) {
    return sessions.getWithFallback(sessionKeyFor(message), message.chatId);
  }

  function resolveAccess(message) {
    const rule = rules[message.chatId] || null;
    const policy = rule?.policy || globalPolicy;
    const allowlist = rule?.allowlist?.length ? rule.allowlist : allowedUserIds;
    const blacklist = rule?.blacklist || [];
    if (policy === "disabled") return { allowed: false, reason: "group-disabled" };
    if (blacklist.includes(message.senderId)) {
      return { allowed: false, reason: "user-blacklisted" };
    }
    if (allowlist.length > 0 && !allowlist.includes(message.senderId)) {
      return { allowed: false, reason: "user-not-allowed" };
    }
    if (
      policy === "allowlist" &&
      allowlist.length === 0 &&
      message.chatType !== "p2p"
    ) {
      return { allowed: false, reason: "allowlist-empty" };
    }
    const requireMention =
      rule?.requireMention === undefined ? config.requireMentionInGroup : rule.requireMention;
    return { allowed: true, requireMention };
  }

  async function sendOne(messageId, chunk) {
    const format = config.replyFormat || "card";
    const attempts = [];

    if (format === "card" && lark.replyCard) {
      attempts.push(() => lark.replyCard(messageId, buildCardMarkdown(chunk)));
    }
    if (format !== "text" && lark.replyMarkdown) {
      attempts.push(() => lark.replyMarkdown(messageId, chunk));
    }
    if (lark.replyText) {
      attempts.push(() => lark.replyText(messageId, chunk));
    }

    let last = { code: 1 };
    for (let i = 0; i < attempts.length; i += 1) {
      last = await attempts[i]();
      if (last.code === 0) return true;
      logger?.warn?.(
        `回复失败（${format}），尝试下一种格式`,
        (last.stderr || last.error || "").slice(0, 200),
      );
    }
    logger?.error("回复飞书消息失败", (last.stderr || last.error || "").slice(0, 300));
    return false;
  }

  async function reply(messageId, text) {
    const chunks = chunkText(text, config.replyChunkSize, config.replyMaxChunks);
    for (const chunk of chunks) {
      if (!(await sendOne(messageId, chunk))) return false;
    }
    return true;
  }

  async function markProcessing(message) {
    if (!reactionsEnabled || !lark.addReaction) return "";
    try {
      return await lark.addReaction(message.messageId, config.reactionProcessingEmoji || "Typing");
    } catch {
      return "";
    }
  }

  async function clearProcessing(message, reactionId) {
    if (!reactionId || !lark.removeReaction) return;
    try {
      await lark.removeReaction(message.messageId, reactionId);
    } catch {
      // 表情清理失败不影响主流程
    }
  }

  async function markFailure(message) {
    if (!reactionsEnabled || !lark.addReaction) return;
    try {
      await lark.addReaction(message.messageId, config.reactionFailureEmoji || "CrossMark");
    } catch {
      // 表情失败静默
    }
  }

  async function handleCommand(command, message) {
    switch (command) {
      case "/help":
        return reply(message.messageId, HELP_TEXT);
      case "/new": {
        const key = sessionKeyFor(message);
        sessions.clear(key);
        if (key !== message.chatId) sessions.clear(message.chatId);
        sessions.save();
        return reply(message.messageId, "已新建会话，下一条消息将开启新的上下文。");
      }
      case "/stop": {
        const controller = running.get(sessionKeyFor(message));
        if (!controller) return reply(message.messageId, "当前没有正在执行的任务。");
        controller.abort();
        return reply(message.messageId, "已发送停止信号。");
      }
      case "/status": {
        const key = sessionKeyFor(message);
        const sessionId = sessionFor(message);
        const masked = sessionId ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : "无";
        const state = running.has(key) ? "执行中" : "空闲";
        return reply(
          message.messageId,
          [
            `状态：${state}`,
            `会话：${masked}`,
            `会话键：${key}`,
            `队列中活跃会话：${queue.pending}`,
          ].join("\n"),
        );
      }
      default:
        break;
    }
    return reply(message.messageId, HELP_TEXT);
  }

  function startRun(message) {
    const key = sessionKeyFor(message);
    if (queue.isBusy(key)) {
      return reply(message.messageId, "上一个任务还在执行。发送 /stop 可终止，或稍后再试。");
    }

    const controller = new AbortController();
    running.set(key, controller);

    const run = queue.push(key, async () => {
      const reactionId = await markProcessing(message);
      try {
        if (config.ack) {
          await reply(message.messageId, "已收到，开始执行…（发送 /stop 可终止）");
        }
        const result = await runCodearts({
          bin: config.codeartsBin,
          prompt: message.text,
          cwd: config.workdir,
          sessionId: sessionFor(message),
          model: config.model,
          agent: config.agent,
          approvalMode: config.approvalMode,
          timeoutMs: config.timeoutMs,
          signal: controller.signal,
        });
        if (!result.aborted && result.sessionID) {
          sessions.set(key, result.sessionID);
        }
        try {
          sessions.save();
        } catch (err) {
          logger?.error("保存会话状态失败", err);
        }
        await reply(message.messageId, summarizeResult(result));
        if (result.error || result.spawnError) await markFailure(message);
      } catch (err) {
        await markFailure(message);
        throw err;
      } finally {
        await clearProcessing(message, reactionId);
        running.delete(key);
      }
    });

    run.catch((err) => logger?.error("任务执行异常", err));
    return run;
  }

  async function handle(rawEvent) {
    const message = normalizeEvent(rawEvent);
    if (!message) return { status: "ignored" };
    if (!seen.check(message.messageId)) return { status: "duplicate" };
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(message.chatId)) {
      logger?.debug("忽略不在白名单内的会话", message.chatId);
      return { status: "blocked", reason: "chat-not-allowed" };
    }

    const access = resolveAccess(message);
    if (!access.allowed) {
      logger?.debug("忽略无权访问的消息", message.chatId, access.reason);
      return { status: "blocked", reason: access.reason };
    }

    if (
      !isAddressedToBot(message, {
        botName: config.botName || "",
        requireMention: access.requireMention,
      })
    ) {
      return { status: "not-addressed" };
    }

    const command = parseCommand(message.text);
    if (command) {
      await handleCommand(command.command, message);
      return { status: "command", command: command.command };
    }
    if (message.text.startsWith("/")) {
      await reply(message.messageId, `未知命令：${message.text.split(/\s+/)[0]}\n\n${HELP_TEXT}`);
      return { status: "unknown-command" };
    }

    if (batcher) {
      batcher.add(sessionKeyFor(message), message);
      return { status: "batched" };
    }

    const run = startRun(message);
    return { status: "started", run };
  }

  handle.startRun = startRun;
  return handle;
}