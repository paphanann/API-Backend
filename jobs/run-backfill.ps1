$ErrorActionPreference = "Stop"

Set-Location "C:\API-Backend\pass-backend"

$node = "C:\Program Files\nodejs\node.exe"
$script = "C:\API-Backend\pass-backend\jobs\backfill-so.js"
$log = "C:\API-Backend\pass-backend\jobs\backfill-so.log"

"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" |
    Out-File $log -Append -Encoding utf8

& $node $script 2>&1 |
    Out-File $log -Append -Encoding utf8

exit $LASTEXITCODE
