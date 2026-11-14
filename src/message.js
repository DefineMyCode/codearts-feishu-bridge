export function renderMentions(content, mentions = []) {
  let text = String(content ?? "");
  for (const mention of mentions) {
    if (!mention || !mention.key) continue;
    const replacement = mention.name ? `@${mention.name}` : "";
    text = text.split(mention.key).join(replacement);
  }
  return text.trim();
}

export function normalizeEvent(raw) {
  if (!raw || raw.type !== "im.message.receive_v1") return null;
  const chatId = raw.chat_id;
  const messageId = raw.message_id || raw.id;
  if (!chatId || !messageId) return null;
  if (raw.sender_type && raw.sender_type !== "user") return null;
  if (raw.message_type && raw.message_type !== "text" && raw.message_type !== "post") return null;

  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  const text = renderMentions(raw.content, mentions);
  if (!text) return null;

  return {
    chatId,
    chatType: raw.chat_type || "p2p",
    messageId,
    text,
    mentions,
    senderId: raw.sender_id || "",
    threadId: raw.thread_id || "",
    rootId: raw.root_id || "",
    createTime: raw.create_time || raw.timestamp || "",
  };
}

export function isAddressedToBot(message, { botName = "", requireMention = true } = {}) {
  if (message.chatType === "p2p") return true;
  if (!requireMention) return true;
  const mentions = message.mentions || [];
  if (mentions.length === 0) return false;
  if (!botName) return true;
  return mentions.some((m) => m && typeof m.name === "string" && m.name.includes(botName));
}

export const COMMANDS = ["/help", "/new", "/stop", "/status"];

export function parseCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [head] = trimmed.split(/\s+/, 1);
  const command = head.toLowerCase();
  if (!COMMANDS.includes(command)) return null;
  return { command, args: trimmed.slice(head.length).trim() };
}

export class Deduper {
  constructor(limit = 500) {
    this.limit = limit;
    this.seenSet = new Set();
    this.order = [];
  }

  check(key) {
    if (!key) return true;
    if (this.seenSet.has(key)) return false;
    this.seenSet.add(key);
    this.order.push(key);
    if (this.order.length > this.limit) {
      const old = this.order.shift();
      this.seenSet.delete(old);
    }
    return true;
  }
}