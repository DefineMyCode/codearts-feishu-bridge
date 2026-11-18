# codearts-feishu-bridge

把华为云码道 CLI（`codearts`）接进飞书单聊 / 群聊的轻量桥接。**零 npm 依赖**，不需要公网地址，不需要飞书自建应用的回调 URL。

## 工作原理

```
飞书消息
  → lark-cli event consume im.message.receive_v1（官方 CLI 的 WebSocket 长连接）
  → 本进程：去重 / 白名单 / 命令解析 / 按会话串行排队
  → codearts run --format json --auto_approval（默认模式，可用 CODEARTS_APPROVAL_MODE 切换；prompt 走 stdin，--session 续上下文）
  → lark-cli im +messages-reply（回到原消息）
```

依赖两个命令行工具：`lark-cli`（飞书官方 CLI）与 `codearts`（码道 CLI）。Node.js ≥ 24（使用内置 node:sqlite 持久化任务），不用 `npm install`。

## 一、准备

### 1. 飞书侧

```bash
# 安装飞书官方 CLI（若尚未安装）
npm i -g @larksuite/cli

# 绑定/创建应用（交互式，会输出授权链接）
lark-cli config init --new

# 登录授权（按提示在浏览器完成）
lark-cli auth login

# 确认身份与控制台事件已开启
lark-cli whoami
lark-cli event schema im.message.receive_v1
```

飞书开发者后台里需要：
- 应用开启机器人能力，并把机器人拉进目标群（群聊场景）
- 开通事件 `im.message.receive_v1`
- 权限 `im:message.p2p_msg:readonly`，以及发送消息所需的消息权限（`im:message:send_as_bot` 或控制台自动授予的等价权限）

`im.message.receive_v1` 的订阅方式选长连接（由 `lark-cli` 负责建立），不要填公网回调地址。

### 2. 码道侧

```bash
codearts --version          # 确认版本
codearts run "只回复：OK"   # 确认已登录且有可用套餐
```

若返回“无法连接到模型服务”，先解决网络/代理或套餐问题，桥接会原样把错误回给你。

## 二、配置

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `CODEARTS_WORKDIR` | 是 | 码道执行任务的工作目录（**所有 IM 消息都只在这个目录里执行**） |
| `LARK_CLI_BIN` | 否 | `lark-cli` 路径，默认走 PATH |
| `LARK_IDENTITY` | 否 | 身份类型，默认 `bot`；也可设 `user` 用你本人的身份收发 |
| `BOT_NAME` | 建议 | 机器人在群里的显示名，用于判断群里是否 @ 了它；不填则“有提及就响应” |
| `GROUP_REQUIRE_MENTION` | 否 | 默认 `true`，群聊必须 @ 机器人才响应 |
| `CODEARTS_TIMEOUT_MS` | 否 | 单任务超时，默认 1800000（30 分钟）；超时会把 stderr 尾部写入任务表 |
| `CODEARTS_MAX_CONCURRENCY` | 否 | 全局同时执行的任务数，默认 2 |
| `ALLOWED_CHAT_IDS` | 否 | 逗号分隔的会话白名单（`oc_` 开头），强烈建议在生产环境配置 |
| `CODEARTS_MODEL` / `CODEARTS_AGENT` | 否 | 指定模型或智能体，留空用默认 |
| `CODEARTS_APPROVAL_MODE` | 否 | 审批模式：`auto`（默认，沙箱 + AI 自动审批）、`manual`（沙箱 + 人工审批，IM 场景会一直等待）、`full`（跳过沙箱与全部检查）；也接受 `auto_approval`/`manual_approval`/`full_access` |
| `REPLY_FORMAT` | 否 | 回复格式：`card`（默认，interactive 卡片，标题/表格/代码块结构化渲染）、`post`（飞书富文本 markdown）、`text`（纯文本）；发送失败会自动降级 |
| `REPLY_CHUNK_SIZE` / `REPLY_MAX_CHUNKS` | 否 | 长结果分段大小与段数，默认 1800 / 4 |
| `BRIDGE_HEARTBEAT_MINUTES` | 否 | 长任务执行中每 N 分钟更新进度卡片显示已用时，默认 5；`0` 关闭 |
| `BRIDGE_ATTACH_LONG_OUTPUT` | 否 | 结果被截断时把完整内容落盘并作为文件附件发回，默认 `true` |
| `BRIDGE_OUTPUT_DIR` | 否 | 长输出落盘目录，默认 `./data/output` |
| `CRON_TASKS` | 否 | 定时任务，每条 `cron|提示词|chat_id`，多条用 `;` 分隔，例如 `0 9 * * *|总结昨天提交|oc_x` |
| `BRIDGE_ACK` | 否 | 是否先回“已收到，开始执行…”，默认 true |
| `STATE_FILE` | 否 | 会话映射持久化位置，默认 `./data/sessions.json` |
| `GROUP_SESSIONS_PER_USER` | 否 | 群内是否按发言人隔离上下文，默认 `true`；设为 `false` 则全群共享 |
| `ALLOWED_USER_IDS` | 否 | 逗号分隔的用户 open_id 白名单；配置后不在名单内的人会被拒绝 |
| `GROUP_POLICY` | 否 | 群消息策略：`open`（默认）、`allowlist`、`disabled` |
| `GROUP_RULES` | 否 | JSON，按 chat_id 覆盖策略与 @ 要求，例如 `{"oc_x":{"policy":"allowlist","allowlist":["ou_y"],"requireMention":false}}` |
| `TEXT_BATCH_DELAY_MS` | 否 | 同一会话连续文本的合并静默期，默认 600 |
| `TEXT_BATCH_MAX_MESSAGES` | 否 | 单批最大合并条数，默认 8 |
| `TEXT_BATCH_MAX_CHARS` | 否 | 单批最大合并字符数，默认 4000 |
| `BRIDGE_MEDIA` | 否 | 是否接收图片/文件/音频/视频并下载到本地，默认 `true` |
| `MEDIA_DIR` | 否 | 附件下载根目录，默认 `./data/media` |
| `MEDIA_RETENTION_DAYS` | 否 | 附件保留天数，启动与每天清理一次，默认 7；设为 0 不清理 |
| `TEXT_INJECT_MAX_BYTES` / `TEXT_INJECT_MAX_CHARS` | 否 | 文本附件自动注入正文的大小与字符上限，默认 100 KB / 8000 字符 |
| `BRIDGE_REACTIONS` | 否 | 是否用表情标记处理状态，默认 `true` |
| `REACTION_PROCESSING` / `REACTION_FAILURE` | 否 | 处理中与失败用的表情类型，默认 `Typing` / `CrossMark` |
| `BRIDGE_PROGRESS_CARD` | 否 | 是否用一张“执行中”卡片原位更新为结果，默认 `true`；更新失败自动回退为普通回复 |
| `BRIDGE_COMPLETION_NOTICE` | 否 | 卡片原位更新成功后补发一条简短完成提醒，默认 `true`；只在单段结果时补发 |
| `DEDUP_FILE` | 否 | 去重记录落盘位置，默认 `./data/seen.json`，仅作为一次性迁移来源 |
| `DEDUP_TTL_MS` / `DEDUP_MAX` | 否 | 去重有效期与容量，默认 24 小时 / 2048 条 |
| `TASK_DB` | 是 | 任务库绝对路径；必填，缺失或相对路径会启动失败 |
| `TASK_AUTO_RETRY` | 否 | 重启后是否自动重投中断任务，默认 `true` |
| `TASK_MAX_ATTEMPTS` | 否 | 总尝试次数上限，含首次，默认 2 |
| `TASK_RETENTION_DAYS` | 否 | 终态任务保留天数，默认 30；0 表示不清理 |

## 三、启动

```bash
node --env-file=.env src/index.js
```

正常日志：

```
INFO lark-cli 1.0.84 就绪
INFO 桥接已启动 | 工作目录=/path/to/your-project | 事件=im.message.receive_v1 | 并发=2
```

`lark-cli` 事件流断开时会自动指数退避重连（1s → 30s 上限）。

生产环境可用 systemd 托管（示例服务名 `codearts-feishu-bridge`，下列路径请按实际环境替换）：

```ini
[Unit]
Description=CodeArts Feishu Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/codearts-feishu-bridge
Environment=HOME=/home/your-user
Environment=PATH=/home/your-user/.codeartsdoer/installers:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/home/your-user/.config/codearts-cli.env
ExecStart=/usr/bin/node --env-file=/path/to/codearts-feishu-bridge/.env /path/to/codearts-feishu-bridge/src/index.js
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

安装与开机自启：

```bash
sudo cp codearts-feishu-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codearts-feishu-bridge
```

日常管理：

```bash
systemctl status codearts-feishu-bridge
journalctl -u codearts-feishu-bridge -f          # 跟踪日志
sudo systemctl restart codearts-feishu-bridge
sudo systemctl disable --now codearts-feishu-bridge
```

> `HOME` 与 `PATH` 必须设置：`lark-cli` 需要从 `~/.larksuite*` 读应用配置，`codearts` 安装在 `~/.codeartsdoer/installers` 下，systemd 默认环境里都找不到。
>
> `EnvironmentFile` 指向提供码道华为云认证变量（`CODEARTS_CLI_AK` / `CODEARTS_CLI_SK`）的文件。交互 shell 里这两个变量是现成的，但 systemd 不会继承，缺了就会“认证失败”并导致回复 `码道退出码 0，没有输出。` 该文件请保持 `chmod 600`。

## 四、使用

- **单聊**：直接发消息，即把任务交给码道
- **群聊**：`@机器人 你的任务`（需配置 `BOT_NAME` 才会精确匹配）
- `/help`：帮助
- `/new`：清掉当前会话上下文，下一条消息开新会话
- `/stop`：终止当前任务（SIGTERM，3 秒后 SIGKILL）；任务执行中的卡片上也带“停止任务”按钮，点击等同发送 `/stop`
- `/status`：查看空闲/执行中、会话 ID、活跃会话数

同一会话内的任务是串行的；不同会话受 `CODEARTS_MAX_CONCURRENCY` 限制。

## 五、安全边界

- 默认 `CODEARTS_APPROVAL_MODE=auto`：沙箱内执行、高风险操作拦截、重要操作由 AI 自动审批。
- 可改为 `manual`（沙箱内但需人工审批，IM 场景无人点会一直等待，不建议）或 `full`（跳过沙箱与全部安全检查）。
- **`full` 等于把本机命令执行权限交给任何能给机器人发消息的人**：只在临时联调时开启，并同时配置 `ALLOWED_CHAT_IDS`；桥接启动时会打印显式 WARN。
- 任务只在 `CODEARTS_WORKDIR` 内执行，IM 消息里的路径不会改变工作目录。
- 生产环境请同时配置 `ALLOWED_CHAT_IDS`，避免机器人被拉进任意群后被人滥用消耗额度。
- `.env` 含凭证信息时不要提交到仓库。

## 六、排障

| 现象 | 处理 |
|---|---|
| 启动报 `not configured` / 事件收不到 | `lark-cli config init`、`lark-cli auth login`，再 `lark-cli whoami` 确认 |
| `事件流退出 code=5` 且错误为 `context canceled` | 事件流子进程的 stdin 被立即关闭（旧版用 `ignore`），`lark-cli` 无界运行遇 EOF 会自行取消。当前版本已把 stdin 保持为打开管道，拉最新代码重启即可 |
| 群里 @ 了但没反应 | 检查应用是否开启 `im.message.receive_v1`、机器人是否在群内、`BOT_NAME` 是否与飞书显示名一致 |
| 回复“码道返回错误：无法连接到模型服务” | 码道侧网络/代理或套餐问题，先在终端直接 `codearts run` 验证 |
| 回复“码道退出码 0，没有输出” | 多半是认证失败：systemd 没继承 `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK`。把它们写进 `~/.config/codearts-cli.env` 并在 unit 里加 `EnvironmentFile=`，再 `systemctl restart` |
| 回复“启动 codearts 失败” | `CODEARTS_BIN` 指向错误或未安装 |
| 任务一直不结束 | 用 `/stop` 终止；检查 `CODEARTS_TIMEOUT_MS` |

## 七、测试

```bash
npm test                 # 单元测试
./scripts/e2e-smoke.sh     # 端到端冒烟：假 lark-cli + 假 codearts，验证整条链路
./scripts/e2e-recovery.sh  # 两阶段恢复演练：任务执行中 kill -9，重启后断言重投并成功
```

单元测试覆盖：消息归一化与 @ 判定、命令解析、去重、会话串行与并发上限、会话持久化、码道 JSON 事件解析/中止/超时/EPIPE、`lark-cli` 参数与 NDJSON 事件流、handler 的确认/结果/停止/异常回复路径，以及卡片的标题/表格/代码块结构化转换与按块分段。

冒烟脚本会启动真实桥接进程，用一个假的 `lark-cli` 推一条消息事件、用一个假的 `codearts` 返回结果，然后断言“已收到”与结果两条回复都发出、会话 ID 已落盘、收到 SIGTERM 能优雅退出。冒烟通过时输出 `E2E SMOKE PASS`。

恢复演练脚本会先启动桥接跑一个慢任务，等任务进入 running 后 kill -9，再启动一次；断言日志出现“中断=1 重投=1 投递=1”，任务最终 succeeded 且 attempts=2，通过时输出 `E2E RECOVERY PASS`。

## 已知限制

- 群聊默认按发言人隔离上下文（`GROUP_SESSIONS_PER_USER=true`）；从旧版本升级时，各人首次发言会继承原来的全群会话，之后独立。
- 支持文本、富文本、图片、文件、音频、视频；富文本里内嵌的文件会回查原始消息体解析后下载。
- 附件下载到 `MEDIA_DIR`，默认保留 7 天，启动时与每天各清理一次；只清理该目录下的文件，不递归子目录。
- 回复默认走 `interactive` 卡片，由桥接把 Markdown 转成结构化元素：首个标题转为卡片 `header`，表格逐行转为 `column_set`（表头加粗、去掉 `|---|` 分隔行），代码块与分割线原样保留；发送失败按 `card → post → text` 自动降级。
- 长回复按块分段（代码块、表格、标题、列表、段落各自成块，表格与代码块不会被空行拆散），超出 `REPLY_CHUNK_SIZE` 才按行切分；每段一张卡片，最多 `REPLY_MAX_CHUNKS` 段。
- 执行中每 `BRIDGE_HEARTBEAT_MINUTES`（默认 5）分钟更新一次进度卡片显示已用时与超时上限，属于整卡刷新，不是 token 级流式。
- 结果超出分段上限且 `BRIDGE_ATTACH_LONG_OUTPUT=true` 时，完整内容落盘到 `BRIDGE_OUTPUT_DIR` 并作为**文件附件**发回飞书；上传失败则回一条服务器路径提示。
- `CRON_TASKS` 支持定时任务：服务每分钟检查一次，命中后以独立会话执行并投递结果；不受会话串行锁影响，也不占用用户上下文。
- `REPLY_FORMAT=post` 走 `lark-cli --markdown`（飞书 post 富文本），代码块与表格支持有限；`REPLY_FORMAT=text` 为纯文本。
- 会话、去重与任务记录统一存在 `TASK_DB` 指向的 SQLite 里，仍只支持单实例，不支持多进程共享。
- 重启时残留的 running 任务会被标记为中断，并按 `TASK_AUTO_RETRY` 与 `TASK_MAX_ATTEMPTS`（默认最多两次尝试）自动重投；重投是整轮重跑，不是断点续跑。
- 用户主动停止（`/stop` 或卡片按钮）记为 `stopped` 终态，重启不会重投；只有进程重启或崩溃造成的中断才是 `interrupted`，才会按策略重投。
- 不重投的中断任务会尝试更新原进度卡片为“任务已中断”，超过 25 分钟窗口或更新失败时改为发一条文本说明。

## License

[MIT](LICENSE) © 2026 Dcsgo