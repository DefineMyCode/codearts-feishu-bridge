import fs from "node:fs";
import path from "node:path";

export class SessionStore {
  constructor(file, { logger } = {}) {
    this.file = file;
    this.logger = logger;
    this.map = new Map();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      for (const [chatId, sessionId] of Object.entries(data)) {
        if (typeof sessionId === "string" && sessionId) this.map.set(chatId, sessionId);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.logger?.warn(`会话状态文件无法解析，按空状态启动: ${this.file}`);
      }
    }
    return this;
  }

  get(chatId) {
    return this.map.get(chatId) || "";
  }

  set(chatId, sessionId) {
    if (!chatId || !sessionId) return;
    this.map.set(chatId, sessionId);
  }

  clear(chatId) {
    return this.map.delete(chatId);
  }

  size() {
    return this.map.size;
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = Object.fromEntries(this.map.entries());
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}