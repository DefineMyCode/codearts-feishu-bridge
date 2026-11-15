# P3-lite 设计：单服务器持久化任务队列

## 一、目标与范围

适用场景：单服务器、单用户、资源有限。只解决三件事：

1. 服务重启后，排队中的任务不丢，自动继续执行。
2. 进程退出时正在执行的任务，重启后能被识别并给出明确状态，而不是让卡片永远停在“执行中”。
3. 任务状态可查，能看到队列长度、执行中任务、最近失败记录。

明确不做：多实例、事件分发层、实例租约与心跳、从中断处续跑、任务优先级、排队中取消。

## 二、设计原则

- 轻量：不引入消息中间件，不拆进程，部署形态保持一个 systemd 服务。
- 规范：任务有明确状态机与时间戳，所有状态迁移落库，可审计。
- 不重复造轮子：队列、并发、会话串行继续用现有的 TaskQueue；持久化用 Node 内置 SQLite。

## 三、技术选型

| 方案 | 结论 | 理由 |
|---|---|---|
| node:sqlite（内置） | 采用 | 无需安装、无需编译；本机 Node 26.5.1 实测可用，DatabaseSync 与 StatementSync 均正常 |
| better-sqlite3 | 不采用 | 原生模块，安装与升级成本高，单用户场景无性能必要 |
| 外部消息队列 | 不采用 | 与“单服务器、轻量”目标冲突 |

代价：package.json 的 engines 需要从 `>=20` 提升到 `>=24`。当前机器满足。node:sqlite 在 22.5 引入，23.4 起无需实验性开关，取 24 作为保守下限。

数据库文件默认 `./data/tasks.db`，启用 WAL：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## 四、数据模型

### 4.1 meta

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

用途：`schema_version`、`migrated_from_json` 等。

### 4.2 sessions

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

与现有 SessionStore 的键语义保持一致：私聊是 chatId，群聊是 chatId:senderId。旧键回退逻辑保留（先查 session_key，再查 legacy chatId）。

### 4.3 tasks

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  session_key         TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  message_id          TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  media_json          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  progress_message_id TEXT,
  result_summary      TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key, status);
```

字段说明：

- id：任务 ID，建议 `task_` + 时间戳 + 随机串，便于日志检索。
- prompt：实际交给 codearts 的完整提示词，包含附件路径与内联文本，恢复时直接复用。
- media_json：附件元数据 JSON 数组，恢复前用于校验文件是否还存在。
- attempts：已尝试次数，含首次。自动重投前判断 `attempts < TASK_MAX_ATTEMPTS`。
- progress_message_id：机器人发的进度卡片消息 ID，用于恢复或中断时更新卡片。

### 4.4 dedup

```sql
CREATE TABLE IF NOT EXISTS dedup (
  message_id TEXT PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_seen ON dedup(seen_at);
```

保留 24 小时 TTL、2048 条上限，启动时与每天各清理一次。

## 五、任务状态机

```
queued ──执行──> running ──成功──> succeeded
                    │
                    ├──失败──> failed
                    └──进程退出/崩溃──> interrupted
interrupted ──自动重投且未超上限──> queued
interrupted ──不重投或超上限──> 保持 interrupted
```

约束：

- 状态只能按上图单向迁移，禁止从终态回到 running。
- attempts 在进入 running 时加一。
- TASK_MAX_ATTEMPTS 表示总尝试次数上限，默认 2（首次 + 一次重投）。
- 终态任务（succeeded / failed / interrupted）保留 TASK_RETENTION_DAYS 天后清理，默认 30 天。

## 六、关键流程

### 6.1 入队

1. handler 归一化消息后，生成 taskId。
2. 写入 tasks：status=queued、prompt、media_json、created_at。
3. 交给 TaskQueue 排队。
4. 队列真正开始执行时，把状态改为 running，记录 started_at，attempts 加一。
5. 发送进度卡片后，把 progress_message_id 回写。

要点：先落库再进内存队列，保证进程在入队与执行之间崩溃也不丢任务。

### 6.2 执行与完成

1. 执行 codearts，拿到结果。
2. 更新会话映射（sessions 表）。
3. 把任务置为 succeeded，写 result_summary、finished_at。
4. 更新进度卡片为结果，失败则按现有逻辑回退为发送新消息。
5. 失败、超时、中止分别写 failed 或 interrupted，error 记录原因。

### 6.3 启动恢复

进程启动、数据库就绪后，按顺序执行：

1. `UPDATE tasks SET status='interrupted', finished_at=now, error='进程重启中断' WHERE status='running'`。
   安全性依据：桥接是单实例，启动时不可能还有本进程的任务在跑；systemd 重启会先杀掉子进程。
2. 处理 interrupted：
   - 若 TASK_AUTO_RETRY 为 true 且 attempts < TASK_MAX_ATTEMPTS：置为 queued，保留 attempts，等待重新投递。
   - 否则：保持 interrupted，用 progress_message_id 更新卡片为“任务已中断”；更新失败则发送一条文本说明。
3. 按 created_at 升序取出全部 queued 任务，按 session_key 分组串行投递。
4. 附件校验：media_json 中每个 localPath 若已不存在（例如被清理），在 prompt 末尾追加说明并继续执行，不阻塞任务。
5. 清理过期 dedup 与过期终态任务。

启动恢复全程只执行一次，且在任何事件订阅开始之前完成，避免新旧任务交错。

### 6.4 优雅关闭

1. 停止两个事件订阅。
2. 对 running 任务发送 abort，最多等待 10 秒。
3. 仍未结束的置为 interrupted（error=服务停止）。
4. 保存去重、关闭数据库。

### 6.5 崩溃恢复

进程被 kill -9 或机器断电时，数据库里会留下 status=running 的记录。下次启动走 6.3 的第 1 步即可，无需额外机制。WAL 保证已提交事务不丢。

### 6.6 卡片状态联动

- 重投的任务沿用原 message_id 与 progress_message_id。
- 飞书卡片更新有 30 分钟窗口。启动恢复时若任务创建时间超过 25 分钟，直接发新消息说明中断，不再尝试 PATCH。
- 状态文案统一：执行中、已完成、已中断（可重试）、失败。

## 七、与现有模块的集成

| 文件 | 改动 |
|---|---|
| src/taskstore.js | 新增。封装 DatabaseSync：初始化、迁移、任务 CRUD、恢复查询、清理 |
| src/sessions.js | SessionStore 增加可选 db 后端；不传时保持 JSON 行为，测试不受影响 |
| src/message.js | Deduper 增加可选 db 后端；保留内存 + 文件模式作为兜底 |
| src/handler.js | startRun 前后写任务状态；回写 progress_message_id；失败与中断分类记录 |
| src/index.js | 启动时跑恢复；关闭时标记 interrupted；初始化 TaskStore |
| src/queue.js | 不变，继续负责进程内并发与会话串行 |
| package.json | engines 提升到 >=24 |

不新增进程，不改变部署形态。

## 八、配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| TASK_DB | ./data/tasks.db | SQLite 文件位置 |
| TASK_AUTO_RETRY | true | 重启后是否自动重投中断任务 |
| TASK_MAX_ATTEMPTS | 2 | 总尝试次数上限，含首次 |
| TASK_RETENTION_DAYS | 30 | 终态任务保留天数，0 表示不清理 |
| STATE_FILE | ./data/sessions.json | 仅作为一次性迁移来源 |
| DEDUP_FILE | ./data/seen.json | 仅作为一次性迁移来源 |

## 九、迁移方案

启动时检查 meta.schema_version：

1. 为 0 或不存在：建表，写 schema_version=1。
2. sessions 表为空且 STATE_FILE 存在：读取 JSON 导入，键值原样写入。
3. dedup 表为空且 DEDUP_FILE 存在：读取未过期记录导入。
4. 写 meta.migrated_from_json=1。
5. 不删除原 JSON 文件，作为备份；日志提示迁移结果。

迁移失败不影响启动：记录错误，继续用空表运行，原文件保留。

## 十、测试方案

单元测试：

- taskstore.test.js：建表、任务创建与状态迁移、按状态查询、清理、WAL 生效。
- recovery.test.js：running 变 interrupted、可重投与不可重投分支、attempts 上限、附件缺失校验。
- migration.test.js：JSON 导入、重复导入幂等、损坏文件兜底。
- handler.test.js 增补：任务状态写入时机、终态记录。

集成测试：

- 扩展 e2e：第一次启动投递任务后 kill -9，第二次启动，断言任务从 interrupted 变 queued 并重新执行，最终 succeeded。
- 断言卡片在恢复后收到状态更新。

回归要求：现有 158 个用例必须全绿。

## 十一、风险与边界

- 至少一次语义：重投会整轮重跑，可能重复执行。代码类任务可接受，但要在 README 写清楚。
- 附件失效：prompt 里记录的是本地路径，附件被清理后重投会缺少上下文，恢复时校验并提示。
- 数据库损坏：启动直接失败并提示备份路径，不做自动修复。
- 卡片更新窗口：超过 30 分钟无法 PATCH，改为发新消息。
- 单实例假设：本设计明确不支持多进程同时写同一个库；多实例需要另外的事件分发与租约设计。

## 十二、分阶段实施

1. 阶段一：TaskStore、建表、迁移，把 sessions 与 dedup 切到数据库。
2. 阶段二：任务记录、启动恢复、优雅关闭标记。
3. 阶段三：卡片状态联动、清理策略、e2e 两阶段测试。

每阶段可独立上线，阶段二完成后即可获得“重启不丢任务”的核心收益。

## 十三、明确不做

- 多实例、事件分发层、租约、心跳。
- 从中断处续跑：执行体是外部进程，无法恢复。
- 任务优先级与排队中取消。
- 分布式队列或外部消息中间件。