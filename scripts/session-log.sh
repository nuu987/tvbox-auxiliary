#!/bin/bash
# Session 日志脚本（Stop hook）
# 每次 session 结束时自动运行，收集 git 变更信息

PROJECT_NAME="TVBox Auxiliary"
LOG_DIR="dev-log"
DATE=$(date +"%Y-%m-%d")
TIME=$(date +"%H:%M")

SESSION_NUM=1
while [ -f "$LOG_DIR/${DATE}-session-${SESSION_NUM}.md" ]; do
    SESSION_NUM=$((SESSION_NUM + 1))
done
LOG_FILE="$LOG_DIR/${DATE}-session-${SESSION_NUM}.md"

mkdir -p "$LOG_DIR"

GIT_AVAILABLE=false
if git rev-parse --is-inside-work-tree &>/dev/null; then
    GIT_AVAILABLE=true
fi

cat > "$LOG_FILE" << HEADER
## ${DATE} Session #${SESSION_NUM}
- **项目**: ${PROJECT_NAME}
- **结束时间**: ${TIME}
HEADER

if [ "$GIT_AVAILABLE" = true ]; then
    DIFF_STAT=$(git diff --stat HEAD~1 2>/dev/null || echo "无法获取变更统计")
    CHANGED_FILES=$(git diff --name-only HEAD~1 2>/dev/null | wc -l | tr -d ' ')
    RECENT_COMMITS=$(git log --oneline --since="4 hours ago" 2>/dev/null || echo "无最近提交")
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

    cat >> "$LOG_FILE" << GITINFO
- **分支**: ${CURRENT_BRANCH}
- **文件变更**: ${CHANGED_FILES} files changed
- **未提交变更**: ${UNCOMMITTED} files

### 本次提交
\`\`\`
${RECENT_COMMITS}
\`\`\`

### 变更详情
\`\`\`
${DIFF_STAT}
\`\`\`
GITINFO
fi

cat >> "$LOG_FILE" << FOOTER

### 下次继续
- [ ] （待填写：下次 session 应该从哪里开始）

---
*自动生成于 ${DATE} ${TIME}*
FOOTER

echo "📝 Session 日志已保存: ${LOG_FILE}"
