#!/bin/bash
# Keeps Tailscale (public link) online: restarts tailscaled if it goes offline or dies.
start_ts(){ sudo pkill tailscaled; sleep 2; sudo nohup /usr/local/bin/tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >> /tmp/tailscaled.log 2>&1 & }
bad=0
while true; do
  on=$(sudo tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"].get("Online"))' 2>/dev/null)
  if [ "$on" = "True" ]; then bad=0; else bad=$((bad+1)); fi
  if [ $bad -ge 2 ]; then echo "$(date) offline -> restarting tailscaled" >> /tmp/ts-watchdog.log; start_ts; bad=0; sleep 30; fi
  sleep 20
done
