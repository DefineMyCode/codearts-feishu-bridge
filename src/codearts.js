import { spawn as defaultSpawn } from "node:child_process";

const MAX_STDERR = 4000;

export function parseEventLine(line) {
  const text = line.trim();
  if (!text || !text.startsWith("{")) return null;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;

  const part = event.part && typeof event.part === "object" ? event.part : null;
  const sessionID = event.sessionID || (part && part.sessionID) || "";

  let chunk = "";
  if (part && typeof part.text === "string" && (!part.type || part.type === "text")) {
    chunk = part.text;
  }
  if (!chunk && typeof event.text === "string" && (!event.type || event.type === "text")) {
    chunk = event.text;
  }

  let error = "";
  if (event.error && typeof event.error === "object") {
    const data = event.error.data || {};
    error = data.message || event.error.message || event.error.name || JSON.stringify(event.error).slice(0, 500);
  }

  return { sessionID, chunk, error };
}

export function buildArgs({ prompt, sessionId, model, agent } = {}) {
  const args = ["run", "--format", "json", "--auto_approval"];
  if (sessionId) args.push("--session", sessionId);
  if (model) args.push("--model", model);
  if (agent) args.push("--agent", agent);
  return args;
}

export function runCodearts({
  bin = "codearts",
  prompt,
  cwd,
  sessionId = "",
  model = "",
  agent = "",
  timeoutMs = 600000,
  signal,
  spawnImpl = defaultSpawn,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    const args = buildArgs({ prompt, sessionId, model, agent });
    const child = spawnImpl(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on?.("error", () => {});

    let buffer = "";
    const chunks = [];
    const plainLines = [];
    let stderrTail = "";
    let sessionID = "";
    let errorText = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const plain = plainLines.join("\n").trim();
      resolve({
        text: chunks.join("").trim() || plain,
        sessionID: sessionID || sessionId,
        stderrTail: stderrTail.trim(),
        error: errorText,
        timedOut,
        aborted,
        ...extra,
      });
    };

    const consume = (line) => {
      const parsed = parseEventLine(line);
      if (!parsed) {
        const plain = line.trim();
        if (plain && !plain.startsWith("{") && plainLines.join("\n").length < 4000) {
          plainLines.push(plain);
        }
        return;
      }
      if (parsed.sessionID) sessionID = parsed.sessionID;
      if (parsed.chunk) chunks.push(parsed.chunk);
      if (parsed.error) errorText = parsed.error;
    };

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (data) => {
      buffer += data;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });
    child.stderr.setEncoding?.("utf8");
    child.stderr.on("data", (data) => {
      stderrTail = (stderrTail + data).slice(-MAX_STDERR);
    });

    child.on("error", (err) => finish({ exitCode: null, spawnError: err.message }));
    child.on("close", (code) => {
      if (buffer.trim()) consume(buffer);
      finish({ exitCode: code });
    });

    try {
      if (prompt) child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      finish({ exitCode: null, spawnError: "无法写入 stdin" });
    }
  });
}

export function summarizeResult(result, { limit = 600 } = {}) {
  if (result.spawnError) return `启动 codearts 失败：${result.spawnError}`;
  if (result.aborted) return "已停止当前任务。";
  if (result.timedOut) return "任务超时，已终止。";
  if (result.text) return result.text;
  if (result.error) return `码道返回错误：${result.error}`;
  const tail = (result.stderrTail || "").slice(-limit);
  if (tail) return `码道没有输出文本，stderr 尾部：\n${tail}`;
  return `码道退出码 ${result.exitCode}，没有输出。`;
}