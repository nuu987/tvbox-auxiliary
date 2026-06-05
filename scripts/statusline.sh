#!/bin/bash
# Claude Code Status Line
# 显示：模型名 | 上下文使用进度条 | 百分比 | 费用

read -r input

model=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','?'))" 2>/dev/null)
tokens=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('context_tokens',0))" 2>/dev/null)
max_tokens=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('max_context_tokens',200000))" 2>/dev/null)
cost=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('session_cost','0'); print(f'\${c}')" 2>/dev/null)

if [ "$max_tokens" -gt 0 ] 2>/dev/null; then
    pct=$((tokens * 100 / max_tokens))
else
    pct=0
fi

filled=$((pct / 10))
empty=$((10 - filled))

if [ "$pct" -lt 50 ]; then
    color="\033[32m"
elif [ "$pct" -lt 80 ]; then
    color="\033[33m"
else
    color="\033[31m"
fi
reset="\033[0m"

bar=""
for ((i=0; i<filled; i++)); do bar+="█"; done
for ((i=0; i<empty; i++)); do bar+="░"; done

short_model=$(echo "$model" | sed 's/claude-//' | sed 's/-[0-9]*$//')

printf "%s ${color}%s${reset} %d%% %s" "$short_model" "$bar" "$pct" "$cost"
