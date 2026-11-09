$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPidFile = Join-Path $taskRoot '.runtime/app.pid'
if (!(Test-Path -LiteralPath $taskPidFile)) { Write-Output '没有此应用的 PID 记录。'; exit 0 }
$taskPid = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid" -ErrorAction SilentlyContinue
if (!$taskProcess) { Write-Output '应用已经停止。'; exit 0 }
$taskEntry = Join-Path $taskRoot 'server/index.ts'
if (!$taskProcess.CommandLine.Contains($taskEntry)) { throw 'PID 已被其他进程使用，拒绝停止。' }
$taskHandle = [System.Diagnostics.Process]::GetProcessById($taskPid)
$taskHandle.Kill()
$taskHandle.WaitForExit(5000) | Out-Null
$taskHandle.Dispose()
Write-Output "已停止Folio进程 $taskPid。"
