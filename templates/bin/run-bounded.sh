#!/usr/bin/env bash
# run-bounded.sh —— 有界执行器：任何可能不返回的命令都必须经过它。
#
# 用法：
#   run-bounded.sh <秒> [--until '<正则>' --log <文件>] -- <命令> [参数...]
#
# 行为：
#   后台起命令（**独立进程组**）→ 每秒检查「进程是否退出 / 日志是否命中」→
#   到点或命中后 kill -TERM -<pgid>，3 秒后仍在则 kill -KILL -<pgid>。
#
# 退出码：
#   0    命令自己退出且退出码为 0，或 --until 正则命中
#   124  超时（进程组已被杀）
#   125  用法错误
#   其它  命令自身的退出码
#
# 为什么不用 timeout(1)：macOS 默认没有；gtimeout 要装 coreutils。
# 这个脚本只依赖 bash 与 ps/kill。
#
# 关键细节 —— `set -m` 让后台任务自成进程组，因此 kill 的是**整组**，
# 起服务的 shell 拉起的子进程（mvn → java、sh → node）会一起被收掉，
# 否则只会杀掉最外层，端口仍被占着，下一轮又卡在同一个地方。

set -u
set -m

SECS=""
UNTIL=""
LOG=""

if [ $# -lt 1 ]; then
    echo "usage: run-bounded.sh <秒> [--until '<正则>' --log <文件>] -- <命令> [参数...]" >&2
    exit 125
fi

case "$1" in
    ''|*[!0-9]*)
        echo "run-bounded: 第一个参数必须是秒数，收到 '$1'" >&2
        exit 125
        ;;
esac
SECS="$1"
shift

while [ $# -gt 0 ]; do
    case "$1" in
        --until)
            [ $# -ge 2 ] || { echo "run-bounded: --until 缺少参数" >&2; exit 125; }
            UNTIL="$2"; shift 2 ;;
        --log)
            [ $# -ge 2 ] || { echo "run-bounded: --log 缺少参数" >&2; exit 125; }
            LOG="$2"; shift 2 ;;
        --)
            shift; break ;;
        *)
            break ;;
    esac
done

if [ $# -eq 0 ]; then
    echo "run-bounded: -- 之后必须有命令" >&2
    exit 125
fi

if [ -n "$UNTIL" ] && [ -z "$LOG" ]; then
    echo "run-bounded: --until 必须配 --log" >&2
    exit 125
fi

START=$(date +%s)
RC_FILE="${TMPDIR:-/tmp}/run-bounded.$$.$$"
: > "$RC_FILE"
trap 'rm -f "$RC_FILE"' EXIT

# 子 shell 自己把退出码写进文件，然后 disown —— 这样 bash 不再把它当作业，
# 也就不会在收尸时往 stderr 打 "Terminated: 15" 这种噪声。
( "$@"; echo $? > "$RC_FILE" ) &
PID=$!
disown "$PID" 2>/dev/null || disown 2>/dev/null || true

RC=""
OUTCOME=""

while :; do
    if [ -s "$RC_FILE" ]; then
        RC=$(cat "$RC_FILE" 2>/dev/null)
        OUTCOME="exited"
        break
    fi

    if [ -n "$UNTIL" ] && [ -f "$LOG" ] && grep -qE -- "$UNTIL" "$LOG" 2>/dev/null; then
        OUTCOME="matched"
        break
    fi

    NOW=$(date +%s)
    if [ $((NOW - START)) -ge "$SECS" ]; then
        OUTCOME="timeout"
        break
    fi

    sleep 1
done

if [ "$OUTCOME" = "exited" ]; then
    exit "$RC"
fi

# 收尸：先 TERM 整组，等 3 秒，还在就 KILL 整组
kill -TERM "-$PID" 2>/dev/null
for _ in 1 2 3; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
done
kill -KILL "-$PID" 2>/dev/null

if [ "$OUTCOME" = "matched" ]; then
    grep -m1 -E -- "$UNTIL" "$LOG" 2>/dev/null | sed 's/^/[run-bounded] 命中: /'
    exit 0
fi

echo "[run-bounded] 超时 ${SECS}s，进程组 $PID 已被终止" >&2
exit 124
