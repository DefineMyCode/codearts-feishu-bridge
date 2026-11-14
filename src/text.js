function parseFence(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { marker: match[1], lang: (match[2] || "").trim() };
}

function splitLongParagraph(paragraph, size) {
  const lines = paragraph.split("\n");
  const pieces = [];
  let buffer = [];
  let bufferLength = 0;
  let fence = null;

  const flush = () => {
    if (buffer.length > 0) {
      pieces.push(buffer.join("\n"));
      buffer = [];
      bufferLength = 0;
    }
  };

  for (const line of lines) {
    if (buffer.length === 0 && line.length + 1 > size) {
      for (let i = 0; i < line.length; i += size) {
        pieces.push(line.slice(i, i + size));
      }
      continue;
    }

    if (buffer.length > 0 && bufferLength + line.length + 1 > size) {
      if (fence) {
        buffer.push(fence.marker);
        flush();
        buffer = [fence.marker + fence.lang];
        bufferLength = buffer[0].length + 1;
      } else {
        flush();
      }
    }

    buffer.push(line);
    bufferLength += line.length + 1;

    const current = parseFence(line);
    if (current) {
      if (!fence) fence = current;
      else if (current.marker[0] === fence.marker[0] && !current.lang) fence = null;
    }
  }

  flush();
  return pieces;
}

export function chunkText(text, size, maxChunks) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return ["（码道没有返回内容）"];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  const flushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }

    flushCurrent();

    if (paragraph.length <= size) {
      current = paragraph;
      continue;
    }

    for (const piece of splitLongParagraph(paragraph, size)) {
      const merged = current ? `${current}\n\n${piece}` : piece;
      if (merged.length <= size) current = merged;
      else {
        flushCurrent();
        chunks.push(piece);
      }
    }
  }
  flushCurrent();

  if (chunks.length <= maxChunks) return chunks;

  const kept = chunks.slice(0, maxChunks);
  const restLength = chunks.slice(maxChunks).join("\n\n").length;
  const note = `\n\n…（内容过长，已截断，剩余 ${restLength} 字符）`;
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = last.slice(0, Math.max(0, size - note.length)) + note;
  return kept;
}