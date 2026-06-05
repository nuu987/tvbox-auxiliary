# TVBox Auxiliary - Node.js Auto Install (Windows)

$NodeLtsVer = '20.18.0'
$MinMajor = 18

Write-Host ''
Write-Host '  TVBox Auxiliary' -ForegroundColor Cyan
Write-Host '  ======================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  [1/2] 正在检查 Node.js...' -ForegroundColor White

# Check Node.js
$needInstall = $false
try {
    $ver = & node -v 2>$null
    if ($ver) {
        $major = [int]($ver -replace 'v','').Split('.')[0]
        if ($major -lt $MinMajor) {
            Write-Host "      当前版本 $ver 过低（需要 v${MinMajor}+），将自动升级。" -ForegroundColor Yellow
            $needInstall = $true
        } else {
            Write-Host "      Node.js $ver 已就绪。" -ForegroundColor Green
        }
    } else {
        $needInstall = $true
    }
} catch {
    $needInstall = $true
}

if (-not $needInstall) {
    Write-Host ''
    exit 0
}

Write-Host '      未检测到 Node.js，正在自动安装...' -ForegroundColor Yellow
Write-Host ''

# Detect architecture
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$msiUrl = "https://nodejs.org/dist/v${NodeLtsVer}/node-v${NodeLtsVer}-${arch}.msi"
$msiFile = "$env:TEMP\node-v${NodeLtsVer}-${arch}.msi"

Write-Host "      正在下载 Node.js v${NodeLtsVer} ($arch)..." -ForegroundColor White
Write-Host "      地址: $msiUrl" -ForegroundColor DarkGray

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($msiUrl, $msiFile)
    Write-Host '      下载完成。' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host '  [失败] 下载 Node.js 失败。' -ForegroundColor Red
    Write-Host ''
    Write-Host '  请手动安装：' -ForegroundColor Yellow
    Write-Host '    1. 访问 https://nodejs.org' -ForegroundColor White
    Write-Host '    2. 下载 LTS 版本并安装' -ForegroundColor White
    Write-Host '    3. 安装完成后重新双击 start.bat' -ForegroundColor White
    Write-Host ''
    exit 1
}

Write-Host '      正在安装 Node.js（可能需要管理员权限）...' -ForegroundColor White

try {
    $process = Start-Process msiexec.exe -ArgumentList "/i `"$msiFile`" /qn /norestart" -Wait -PassThru -Verb RunAs
    if ($process.ExitCode -ne 0) {
        throw "installer exit code: $($process.ExitCode)"
    }
    Remove-Item $msiFile -Force -ErrorAction SilentlyContinue
    Write-Host "      Node.js v${NodeLtsVer} 安装成功！" -ForegroundColor Green

    # Refresh PATH
    $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = "$machinePath;$userPath"
} catch {
    Remove-Item $msiFile -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '  [失败] Node.js 安装失败。' -ForegroundColor Red
    Write-Host "  错误: $_" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  请手动安装：' -ForegroundColor Yellow
    Write-Host '    1. 访问 https://nodejs.org' -ForegroundColor White
    Write-Host '    2. 下载 LTS 版本并安装' -ForegroundColor White
    Write-Host '    3. 安装完成后重新双击 start.bat' -ForegroundColor White
    Write-Host ''
    exit 1
}

# Verify
try {
    $ver = & node -v 2>$null
    if (-not $ver) {
        throw 'node not available'
    }
    Write-Host "      验证通过: Node.js $ver" -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host '  [提示] Node.js 已安装，但需要重新打开窗口才能生效。' -ForegroundColor Yellow
    Write-Host '  请关闭此窗口，然后重新双击 start.bat' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

Write-Host ''
exit 0
