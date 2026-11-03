$listen = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listen) { exit 0 }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden
