#!/usr/bin/env bash
# Keeps the day-planner server running (restarts on crash). Start: ./run.sh start | stop | status
DIR="$(cd "$(dirname "$0")" && pwd)"; PIDF="$DIR/data/supervisor.pid"; LOG="$DIR/data/server.log"
case "$1" in
  start)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "already running"; exit 0; fi
    nohup setsid bash -c "while true; do bash -lc 'cd \"$DIR\" && exec node server.js' >> \"$LOG\" 2>&1; echo \"\$(date -Is) server exited, restarting in 3s\" >> \"$LOG\"; sleep 3; done" >/dev/null 2>&1 &
    echo $! > "$PIDF"; echo "started supervisor $(cat "$PIDF")";;
  stop)
    [ -f "$PIDF" ] && kill -- -"$(ps -o pgid= "$(cat "$PIDF")" | tr -d ' ')" 2>/dev/null; rm -f "$PIDF"; echo stopped;;
  status)
    curl -s --max-time 3 localhost:${PORT:-8787}/healthz && echo || echo "down";;
  *) echo "usage: $0 start|stop|status";;
esac
