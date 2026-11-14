import path from "node:path";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

const REPLY_FORMATS = ["card", "post", "text"];
const APPROVAL_MODES = ["auto", "manual", "full"];

export function loadConfig(env = process.env) {
  if (!env.CODEARTS_WORKDIR) {
    throw new Error("缺少必填环境变量: CODEARTS_WORKDIR");
  }

  const replyFormat = (env.REPLY_FORMAT || "card").toLowerCase();
  if (!REPLY_FORMATS.includes(replyFormat)) {
    throw new Error('REPLY_FORMAT 只能是 "card"、"post" 或 "text"');
  }

  const approvalAliases = { auto_approval: "auto", manual_approval: "manual", full_access: "full" };
  const rawApproval = (env.CODEARTS_APPROVAL_MODE || "auto").toLowerCase();
  const approvalMode = approvalAliases[rawApproval] || rawApproval;
  if (!APPROVAL_MODES.includes(approvalMode)) {
    throw new Error('CODEARTS_APPROVAL_MODE 只能是 "auto"、"manual" 或 "full"');
  }

  return {
    larkBin: env.LARK_CLI_BIN || "lark-cli",
    larkIdentity: env.LARK_IDENTITY || "bot",
    eventKey: env.LARK_EVENT_KEY || "im.message.receive_v1",
    botName: env.BOT_NAME || "",
    requireMentionInGroup: bool(env.GROUP_REQUIRE_MENTION, true),
    codeartsBin: env.CODEARTS_BIN || "codearts",
    workdir: path.resolve(env.CODEARTS_WORKDIR),
    model: env.CODEARTS_MODEL || "",
    agent: env.CODEARTS_AGENT || "",
    approvalMode,
    timeoutMs: int(env.CODEARTS_TIMEOUT_MS, 600000),
    maxConcurrency: int(env.CODEARTS_MAX_CONCURRENCY, 2),
    allowedChatIds: (env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stateFile: path.resolve(env.STATE_FILE || "./data/sessions.json"),
    replyFormat,
    replyChunkSize: int(env.REPLY_CHUNK_SIZE, 1800),
    replyMaxChunks: int(env.REPLY_MAX_CHUNKS, 4),
    ack: bool(env.BRIDGE_ACK, true),
    logLevel: (env.LOG_LEVEL || "info").toUpperCase(),
  };
}