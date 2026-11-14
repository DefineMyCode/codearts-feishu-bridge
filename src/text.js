export function chunkText(text, size, maxChunks) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return ["（码道没有返回内容）"];
  const chunks = [];
  let rest = normalized;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= size) {
      chunks.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    const note = `\n\n…（内容过长，已截断，剩余 ${rest.length} 字符）`;
    const index = chunks.length - 1;
    chunks[index] = chunks[index].slice(0, Math.max(0, size - note.length)) + note;
  }
  return chunks;
}