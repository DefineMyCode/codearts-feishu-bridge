import path from "node:path";

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const REPLY_FORMATS = ["card", "post", "text"];
const APPROVAL_MODES = ["auto", "manual", "full"];
const GROUP_POLICIES = ["open", "allowlist", "disabled"];

function parseGroupRules(raw) {
  if (!raw || !String(raw).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GROUP_RULES 必须是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GROUP_RULES 必须是 {chatId: rule} 形式的对象");
  }
  const rules = {};
  for (const [chatId, rule] of Object.entries(parsed)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`GROUP_RULES 中 ${chatId} 的规则必须是对象`);
    }
    const policy = rule.policy ? String(rule.policy).toLowerCase() : "";
    if (policy && !GROUP_POLICIES.includes(policy)) {
      throw new Error(`GROUP_RULES 中 ${chatId} 的 policy 只能是 open、allowlist 或 disabled`);
    }
    rules[chatId] = {
      policy,
      allowlist: Array.isArray(rule.allowlist) ? rule.allowlist.map(String) : [],
      blacklist: Array.isArray(rule.blacklist) ? rule.blacklist.map(String) : [],
      requireMention: rule.requireMention === undefined ? undefined : Boolean(rule.requireMention),
    };
  }
  return rules;
}

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

  const groupPolicy = (env.GROUP_POLICY || "open").toLowerCase();
  if (!GROUP_POLICIES.includes(groupPolicy)) {
    throw new Error('GROUP_POLICY 只能是 "open"、"allowlist" 或 "disabled"');
  }

  return {
    larkBin: env.LARK_CLI_BIN || "lark-cli",
    larkIdentity: env.LARK_IDENTITY || "bot",
    eventKey: env.LARK_EVENT_KEY || "im.message.receive_v1",
    botName: env.BOT_NAME || "",
    requireMentionInGroup: bool(env.GROUP_REQUIRE_MENTION, true),
    groupSessionsPerUser: bool(env.GROUP_SESSIONS_PER_USER, true),
    allowedUserIds: list(env.ALLOWED_USER_IDS),
    groupPolicy,
    groupRules: parseGroupRules(env.GROUP_RULES),
    codeartsBin: env.CODEARTS_BIN || "codearts",
    workdir: path.resolve(env.CODEARTS_WORKDIR),
    model: env.CODEARTS_MODEL || "",
    agent: env.CODEARTS_AGENT || "",
    approvalMode,
    timeoutMs: int(env.CODEARTS_TIMEOUT_MS, 600000),
    maxConcurrency: int(env.CODEARTS_MAX_CONCURRENCY, 2),
    allowedChatIds: list(env.ALLOWED_CHAT_IDS),
    stateFile: path.resolve(env.STATE_FILE || "./data/sessions.json"),
    dedupFile: path.resolve(env.DEDUP_FILE || "./data/seen.json"),
    dedupTtlMs: int(env.DEDUP_TTL_MS, 24 * 60 * 60 * 1000),
    dedupMax: int(env.DEDUP_MAX, 2048),
    textBatchDelayMs: int(env.TEXT_BATCH_DELAY_MS, 600),
    textBatchMaxMessages: int(env.TEXT_BATCH_MAX_MESSAGES, 8),
    textBatchMaxChars: int(env.TEXT_BATCH_MAX_CHARS, 4000),
    reactions: bool(env.BRIDGE_REACTIONS, true),
    reactionProcessingEmoji: env.REACTION_PROCESSING || "Typing",
    reactionFailureEmoji: env.REACTION_FAILURE || "CrossMark",
    replyFormat,
    progressCard: bool(env.BRIDGE_PROGRESS_CARD, true),
    replyChunkSize: int(env.REPLY_CHUNK_SIZE, 1800),
    replyMaxChunks: int(env.REPLY_MAX_CHUNKS, 4),
    ack: bool(env.BRIDGE_ACK, true),
    logLevel: (env.LOG_LEVEL || "info").toUpperCase(),
  };
}