# 飞书能力对齐方案（对标 Hermes）

目标：在不引入飞书 SDK、保持零 npm 依赖与 lark-cli 长连接架构的前提下，把 CodeArts 桥接的飞书能力按优先级对齐到 Hermes 的实现水平。

## 一、能力对照

| 维度 | 当前桥接 | Hermes | 目标阶段 |
|---|---|---|---|
| 连接 | lark-cli 长连接，单事件 | WS + Webhook 双模式 | 不做（长连接已够） |
| 消息类型 | text / post | 11 类 + 媒体缓存 | P2 |
| 准入 | ALLOWED_CHAT_IDS + @ 判定 | 用户白名单 + 全局群策略 + 按群规则 + 管理员 + 机器人间消息 | P0 / P1 |
| 去重 | 内存 500 条，无 TTL，重启丢失 | 24 小时 TTL、2048 条、落盘 | P0 |
| 批处理 | 无 | 0.6 秒 / 8 条 / 4000 字符 | P0 |
| 会话隔离 | 单一 chatId 映射 | chat_id + 参与者 id 两段键 | P0 |
| 回复 | 自研 card / post / text 三级降级 + 分块 | markdown 转 post + 回退 | 保留现状（更精细） |
| 交互 | 无按钮、无回调、无表情 | 审批按钮、选择题卡片、状态表情 | P1 |
| 文档 / 会议 | 无 | 文档评论回复、会议邀请 | 不做 |

## 二、阶段划分

### P0：会话与准入基础（本次实施）

1. 会话键升级
   - 群聊键为 chatId:senderId，私聊键为 chatId。
   - 开关 GROUP_SESSIONS_PER_USER 控制群内是否按人隔离，默认开启。
   - 读取时先查新键，取不到再回退旧键（chatId），保证升级不丢上下文。

2. 去重持久化
   - 24 小时 TTL、2048 条上限、落盘到 DEDUP_FILE。
   - 启动加载，退出保存，写入采用临时文件 + rename。

3. 准入升级
   - 新增 ALLOWED_USER_IDS 用户白名单。
   - 新增 GROUP_POLICY：open / allowlist / disabled，默认 open 以保持现有行为。
   - 新增 GROUP_RULES：按 chat_id 覆盖 policy、allowlist、requireMention。
   - 判定顺序：去重 → 会话白名单 → 用户白名单 → 群策略 → @ 判定。

4. 文本批处理与状态表情
   - 同一会话 600 毫秒内的连续文本合并，最多 8 条、4000 字符。
   - 处理中打 Typing 表情，成功移除，失败替换为 CrossMark。
   - 表情失败只记日志，不影响主流程。

验收：npm test 全绿；新增用例覆盖上述四项；默认配置下私聊行为与当前一致。

### P1：交互能力

1. 订阅 card.action.trigger，按钮回调走统一协议，合成 /card 命令。
2. 审批卡片与选择题卡片复用同一按钮结构。
3. 卡片原位更新：使用回调返回的 token 调用 interactive/v1/card/update，注意 token 30 分钟有效、最多更新 2 次。
4. 前置实验：跑 codearts run --format json --manual_approval，确认事件流是否暴露审批请求，以及 CLI 是否等待 stdin。若无外部审批入口，本阶段只保留 auto 模式与事后审计。

### P2：多类型入站

1. 放开 image / file / audio / media。
2. 用 im +messages-resources-download 下载到 data/media/{messageId}/，把路径拼进 prompt。
3. 小于 100 KB 的 txt / md 直接注入正文。

### P3：持久化队列与多实例支持（需事件分发层）

这一阶段要解决的是多个进程（多服务、多机器、多应用）共存，而不是多个群并发。多个群并发在 P0 完成后即可支持，只是受 CODEARTS_MAX_CONCURRENCY 限制。

1. 持久化队列
   - 会话映射与任务记录迁移到 SQLite，支持进程重启后队列不丢、任务状态可查。
   - 未完成的任务在重启后标记失败或重新投递，不承诺从中断处继续执行；执行体是外部 codearts 子进程，进程终止后该轮状态即丢失。

2. 多实例支持（必须先有事件分发层）
   - 事件订阅收敛：同一事件只能由一个消费者处理，否则多个进程会各自回复一次。可选方案是单进程订阅加内部转发，或引入分发服务。
   - 去重共享：去重记录必须落在共享存储，使用行级锁或租约避免并发写入冲突。
   - 会话与队列写入改为带锁的数据库事务，替代当前的 JSON 全量读写。
   - 实例注册与心跳，避免同一任务被多个实例重复领取。

3. 明确不做的事
   - 不引入 Webhook 模式，避免额外公网暴露面。
   - 不做多 profile 与 app_id 级互斥锁，单实例 systemd 场景不需要。

## 三、风险与约束

- 审批卡片依赖 codearts 是否暴露外部审批入口，未验证前不排期。
- 飞书卡片更新次数受限（token 30 分钟、最多 2 次），流式体验只能做两段式。
- 群内按人隔离默认开启后，群聊上下文会从“全群共享”变为“每人一份”，属有意变更，需在发布说明中标注。
- 多实例改造属于架构级变更，不能只换存储；事件重复消费是首要障碍。

## 四、配置新增项

| 变量 | 默认值 | 说明 |
|---|---|---|
| GROUP_SESSIONS_PER_USER | true | 群内是否按人隔离上下文 |
| ALLOWED_USER_IDS | 空 | 允许使用机器人的用户 open_id |
| GROUP_POLICY | open | open / allowlist / disabled |
| GROUP_RULES | 空 | JSON，按 chat_id 覆盖策略 |
| TEXT_BATCH_DELAY_MS | 600 | 文本合并静默期 |
| TEXT_BATCH_MAX_MESSAGES | 8 | 单批最大条数 |
| TEXT_BATCH_MAX_CHARS | 4000 | 单批最大字符数 |
| BRIDGE_REACTIONS | true | 是否显示处理状态表情 |
| DEDUP_FILE | ./data/seen.json | 去重持久化位置 |
| DEDUP_TTL_MS | 86400000 | 去重记录有效期 |
| DEDUP_MAX | 2048 | 去重记录上限 |