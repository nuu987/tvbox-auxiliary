#!/bin/bash
# ============================================================
# TVBox Auxiliary — Mac/Linux 一键启动
# 双击此文件即可启动服务
# ============================================================

[ ! -x "$0" ] && chmod +x "$0"
cd "$(dirname "$0")"

MIN_NODE_MAJOR=18
NODE_LTS_VER="20.18.0"

echo ""
echo "  TVBox Auxiliary"
echo "  ======================"
echo ""

# ============================================================
# Step 1: 检查 Node.js
# ============================================================
echo "  [1/2] 正在检查 Node.js..."

NEED_INSTALL=false

if command -v node &>/dev/null; then
    CUR_NODE=$(node -v 2>/dev/null)
    CUR_MAJOR=$(echo "$CUR_NODE" | sed 's/v//' | cut -d. -f1)

    if [[ "$CUR_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
        echo "      当前版本 $CUR_NODE 过低（需要 v${MIN_NODE_MAJOR}+），将自动升级。"
        NEED_INSTALL=true
    else
        echo "      Node.js $CUR_NODE 已就绪。"
    fi
else
    echo "      未检测到 Node.js，将自动安装。"
    NEED_INSTALL=true
fi

# ============================================================
# 安装 Node.js（如果需要）
# ============================================================
if [[ "$NEED_INSTALL" == "true" ]]; then

    INSTALL_OK=false

    # --- 优先 Homebrew ---
    if command -v brew &>/dev/null; then
        echo "      正在通过 Homebrew 安装 Node.js..."

        if brew install node@20 2>/dev/null; then
            brew link --overwrite node@20 2>/dev/null || true
            INSTALL_OK=true
        else
            if brew install node 2>/dev/null; then
                INSTALL_OK=true
            fi
        fi

        if [[ "$INSTALL_OK" == "true" ]]; then
            CUR_NODE=$(node -v 2>/dev/null)
            echo "      Node.js $CUR_NODE 安装成功。"
        else
            echo "      Homebrew 安装未成功，尝试其他方式..."
        fi
    fi

    # --- 回退：从 nodejs.org 下载 .pkg ---
    if [[ "$INSTALL_OK" == "false" ]]; then
        echo "      正在下载 Node.js v${NODE_LTS_VER} 安装包..."

        PKG_URL="https://nodejs.org/dist/v${NODE_LTS_VER}/node-v${NODE_LTS_VER}.pkg"
        PKG_FILE="/tmp/node-v${NODE_LTS_VER}.pkg"

        if curl -fL --progress-bar "$PKG_URL" -o "$PKG_FILE"; then
            echo "      正在安装 Node.js（可能需要输入密码）..."

            if sudo installer -pkg "$PKG_FILE" -target / 2>/dev/null; then
                rm -f "$PKG_FILE"
                INSTALL_OK=true
                CUR_NODE=$(node -v 2>/dev/null)
                echo "      Node.js $CUR_NODE 安装成功。"
            else
                rm -f "$PKG_FILE"
            fi
        fi
    fi

    # --- 全部失败 ---
    if [[ "$INSTALL_OK" == "false" ]]; then
        echo ""
        echo "  [失败] 无法自动安装 Node.js。"
        echo ""
        echo "  请手动安装："
        echo "    1. 访问 https://nodejs.org"
        echo "    2. 下载 LTS 版本并安装"
        echo "    3. 安装完成后重新双击此文件"
        echo ""
        read -rp "  按回车键退出..."
        exit 1
    fi
fi

# ============================================================
# Step 2: 启动服务
# ============================================================
echo ""
echo "  [2/2] 正在启动服务..."
echo ""

node scripts/start.js

echo ""
read -rp "  按回车键退出..."
