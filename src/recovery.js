export function recoverTasks({ store, config, logger, submit, now = Date.now() }) {
  if (!store) throw new Error("recoverTasks 需要 TaskStore");

  const interrupted = store.markRunningAsInterrupted({
    error: "进程重启中断",
    now,
  });
  if (interrupted > 0) {
    logger?.info?.(`已将 ${interrupted} 个残留执行中的任务标记为中断`);
  }

  let requeued = 0;
  if (config.taskAutoRetry) {
    for (const task of store.listByStatus("interrupted")) {
      if (task.attempts < config.taskMaxAttempts && store.requeue(task.id) > 0) {
        requeued += 1;
      }
    }
  }

  const queued = store.listByStatus("queued");
  for (const task of queued) {
    submit(task);
  }

  return { interrupted, requeued, submitted: queued.length };
}

export function taskToMessage(task) {
  const meta = task && task.media && !Array.isArray(task.media) ? task.media : {};
  return {
    chatId: task.chatId,
    messageId: task.messageId,
    chatType: meta.chatType || "p2p",
    messageType: meta.messageType || "text",
    mediaType: meta.mediaType || "",
    text: meta.text || "",
    mentions: Array.isArray(meta.mentions) ? meta.mentions : [],
    senderId: meta.senderId || "",
  };
}