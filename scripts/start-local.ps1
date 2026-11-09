$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskRuntime = Join-Path $taskRoot '.runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskPort = if ($env:PORT) { [int]$env:PORT } else { 3210 }
$taskEntry = Join-Path $taskRoot 'server/index.ts'
$taskPidFile = Join-Path $taskRuntime 'app.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskExistingPid = [int](Get-Content -LiteralPath $taskPidFile -Raw)
    $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$taskExistingPid" -ErrorAction SilentlyContinue
    if ($taskExisting -and $taskExisting.CommandLine.Contains($taskEntry)) {
        Write-Output "Folio已在运行：http://127.0.0.1:$taskPort/ (PID $taskExistingPid)"
        exit 0
    }
}
$taskNode = (Get-Command node.exe).Source
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('--import', 'tsx', ('"{0}"' -f $taskEntry)) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRuntime 'app.log') -RedirectStandardError (Join-Path $taskRuntime 'app.error.log') -PassThru
for ($taskTry = 0; $taskTry -lt 25; $taskTry++) {
    Start-Sleep -Milliseconds 400
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw "启动失败，请查看 $taskRuntime/app.error.log" }
    try {
        $taskResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$taskPort/" -UseBasicParsing -TimeoutSec 2
        if ($taskResponse.StatusCode -eq 200) { Set-Content -LiteralPath $taskPidFile -Value $taskProcess.Id -Encoding ascii; Write-Output "Folio正在运行：http://127.0.0.1:$taskPort/ (PID $($taskProcess.Id))"; exit 0 }
    } catch { }
}
throw "尚未收到就绪响应，请查看 $taskRuntime/app.error.log"
