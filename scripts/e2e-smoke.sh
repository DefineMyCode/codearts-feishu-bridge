#!/bin/sh
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/lark-cli" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "lark-cli 9.9.9-e2e" ;;
  whoami) echo '{"identity":"bot","app_id":"cli_e2e"}' ;;
  event)
    echo '{"type":"im.message.receive_v1","chat_id":"oc_e2e","chat_type":"p2p","message_id":"om_e2e","message_type":"text","sender_type":"user","content":"跑个冒烟","mentions":[]}'
    sleep 10
    ;;
  im)
    echo "$@" >> "$REPLY_LOG"
    echo '{"code":0}'
    ;;
esac
EOF

cat > "$WORK/codearts" <<'EOF'
#!/bin/sh
cat > /dev/null
echo '{"type":"text","sessionID":"ses_e2e","part":{"type":"text","text":"E2E-OK"}}'
EOF

chmod +x "$WORK/lark-cli" "$WORK/codearts"

export LARK_CLI_BIN="$WORK/lark-cli"
export CODEARTS_BIN="$WORK/codearts"
export CODEARTS_WORKDIR="$ROOT"
export STATE_FILE="$WORK/sessions.json"
export REPLY_LOG="$WORK/replies.log"
export LOG_LEVEL=info

node "$ROOT/src/index.js" > "$WORK/stdout.log" 2>&1 &
PID=$!
sleep 3
kill -TERM "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

echo "--- 桥接日志 ---"
cat "$WORK/stdout.log"
echo "--- 飞书调用 ---"
cat "$REPLY_LOG" 2>/dev/null || echo "(没有调用)"
echo "--- 会话状态 ---"
cat "$WORK/sessions.json" 2>/dev/null || echo "(没有状态文件)"

grep -q "msg-type interactive" "$WORK/replies.log"
grep -q "E2E-OK" "$WORK/replies.log"
grep -q "ses_e2e" "$WORK/sessions.json"
echo "E2E SMOKE PASS"