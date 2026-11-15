import fs from "node:fs";
import path from "node:path";

export const MEDIA_TYPES = ["image", "file", "audio", "media"];

export const TEXT_RESOURCE_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".yml",
  ".yaml",
];

export function isMediaMessage(message) {
  return Boolean(message && MEDIA_TYPES.includes(message.mediaType));
}

export function isTextResource(resource) {
  const ext = path.extname(String(resource?.localPath || "")).toLowerCase();
  return TEXT_RESOURCE_EXTENSIONS.includes(ext);
}

export function readTextResource(resource, { maxBytes = 102400, maxChars = 8000 } = {}) {
  try {
    const stat = fs.statSync(resource.localPath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(resource.localPath, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

export function buildResourceNote(resources = [], { maxBytes, maxChars } = {}) {
  if (!Array.isArray(resources) || resources.length === 0) return "";
  const lines = ["", "【用户附带资源】"];
  for (const resource of resources) {
    const label =
      resource.type === "image" ? "图片" : resource.type === "file" ? "文件" : resource.type || "附件";
    lines.push(`- ${label}：${resource.localPath}`);
    if (isTextResource(resource)) {
      const content = readTextResource(resource, { maxBytes, maxChars });
      if (content) {
        lines.push("  文件内容如下：");
        lines.push("```");
        lines.push(content);
        lines.push("```");
      }
    }
  }
  return lines.join("\n");
}

export function composePrompt(text, resources, options = {}) {
  const note = buildResourceNote(resources, options);
  const base = String(text || "").trim();
  if (!note) return base || "请查看随消息附带的资源。";
  return base ? `${base}\n${note}` : note.trim();
}