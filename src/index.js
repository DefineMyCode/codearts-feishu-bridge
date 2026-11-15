import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { LarkCli } from "./larkcli.js";
import { SessionStore } from "./sessions.js";
import { TaskQueue } from "./queue.js";
import { Deduper } from "./message.js";
import { TextBatcher } from "./batching.js";
import { createMessageHandler } from "./handler.js";
import { runCodearts } from "./codearts.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

if (!fs.existsSync(config.workdir)) {
  logger.error(`CODEARTS_WORKDIR 不存在：${config.workdir}`);
  process.exit(1);
}

const sessions = new SessionStore(config.stateFile, { logger }).load();
const queue = new TaskQueue({ maxConcurrency: config.maxConcurrency });
const deduper = new Deduper({
  max: config.dedupMax,
  ttlMs: config.dedupTtlMs,
  file: config.dedupFile,
  logger,
}).load();
const lark = new LarkCli({
  bin: config.larkBin,
  identity: config.larkIdentity,
  eventKey: config.eventKey,
  logger,
});

const version = await lark.version();
if (!version) {
  logger.error(`找不到 lark-cli（${config.larkBin}），请安装或设置 LARK_CLI_BIN 为绝对路径`);
  process.exit(1);
}
logger.info(`lark-cli ${version} 就绪`);

const status = await lark.status();
if (!status.ok) {
  const detail = String(status.detail || "");
  if (detail.includes("not_configured") || detail.includes("not configured")) {
    logger.error("lark-cli 尚未配置应用，请先执行：lark-cli config init --new && lark-cli auth login");
    process.exit(1);
  }
  logger.warn(`lark-cli 身份检查失败，继续启动：${detail.slice(0, 200)}`);
}

let handle;
const batcher = new TextBatcher({
  delayMs: config.textBatchDelayMs,
  maxMessages: config.textBatchMaxMessages,
  maxChars: config.textBatchMaxChars,
  onFlush: (message) => {
    const run = handle.startRun(message);
    if (run && typeof run.catch === "function") {
      run.catch((err) => logger.error("批处理任务执行失败", err));
    }
  },
});

handle = createMessageHandler({
  config,
  sessions,
  queue,
  lark,
  logger,
  runCodearts,
  deduper,
  batcher,
});

const consumer = lark.startConsuming({
  onEvent: (event) => {
    handle(event).catch((err) => logger.error("消息处理失败", err));
  },
  onFatal: (detail) => logger.error("事件流持续重连失败，请检查 lark-cli 配置:", detail),
});

const cardLark = new LarkCli({
  bin: config.larkBin,
  identity: config.larkIdentity,
  eventKey: "card.action.trigger",
  logger,
});
const cardConsumer = cardLark.startConsuming({
  onEvent: (event) => {
    handle.cardAction(event).catch((err) => logger.error("卡片回调处理失败", err));
  },
  onFatal: (detail) => logger.error("卡片回调流持续重连失败:", detail),
});

if (config.approvalMode === "full") {
  logger.warn("已启用 full_access：任务将跳过沙箱与全部安全检查，请务必配置 ALLOWED_CHAT_IDS");
}
if (config.groupSessionsPerUser) {
  logger.info("群聊会话按参与者隔离已开启（GROUP_SESSIONS_PER_USER=true）");
}

logger.info(
  `桥接已启动 | 工作目录=${config.workdir} | 事件=${config.eventKey} | 并发=${config.maxConcurrency} | 审批=${config.approvalMode}`,
);

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`收到 ${signal}，正在退出`);
  consumer.stop();
  cardConsumer.stop();
  batcher.stop();
  try {
    batcher.flushAll();
  } catch (err) {
    logger.error("刷新批处理队列失败", err);
  }
  try {
    sessions.save();
    deduper.save();
  } catch (err) {
    logger.error("保存状态失败", err);
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));