#!/usr/bin/env python3
"""
TVBox Auxiliary 环境体检脚本（SessionStart hook）

每次 Claude Code session 启动时自动运行，检查开发环境状态。
"""

import io
import os
import subprocess
import sys
from pathlib import Path

# Force UTF-8 stdout on Windows (GBK can't encode emoji/Chinese)
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def check_node():
    """检查 Node.js 版本"""
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True, text=True, timeout=5
        )
        version = result.stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
        if major < 18:
            print(f"⚠️  Node.js {version}，需要 18+")
            return False
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        print("⚠️  未找到 Node.js")
        return False
    return True


def check_node_modules():
    """检查 node_modules 是否存在"""
    if not Path("node_modules").exists():
        print("⚠️  未找到 node_modules，运行 npm install")
        return False
    return True


def check_git_status():
    """检查 git 状态"""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return True

        result = subprocess.run(
            ["git", "stash", "list"],
            capture_output=True, text=True, timeout=5
        )
        if result.stdout.strip():
            stash_count = len(result.stdout.strip().split("\n"))
            print(f"📌 有 {stash_count} 个 stash 未处理")

        result = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=5
        )
        if result.stdout.strip():
            changed = len(result.stdout.strip().split("\n"))
            print(f"📝 有 {changed} 个文件有未提交的变更")

        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, timeout=5
        )
        branch = result.stdout.strip()
        if branch:
            print(f"🌿 当前分支: {branch}")

    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return True


def check_last_session():
    """读取上次 session 日志"""
    dev_log_dir = Path("dev-log")
    if dev_log_dir.exists():
        logs = sorted(dev_log_dir.glob("*.md"), reverse=True)
        if logs:
            latest = logs[0]
            print(f"\n📋 上次 Session 日志: {latest.name}")


def main():
    print("🔍 环境体检...\n")

    checks = [
        ("Node.js", check_node),
        ("node_modules", check_node_modules),
        ("Git 状态", check_git_status),
    ]

    warnings = []
    for name, check_fn in checks:
        if not check_fn():
            warnings.append(name)

    print()
    if warnings:
        print(f"⚠️  体检完成，{len(warnings)} 项需要注意: {', '.join(warnings)}")
    else:
        print("✅ 环境体检通过，一切就绪！")

    check_last_session()


if __name__ == "__main__":
    main()
