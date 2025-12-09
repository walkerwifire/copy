$ErrorActionPreference = 'Stop'
$techsPath = Join-Path (Get-Location) 'techs.json'
$techs = Get-Content $techsPath | ConvertFrom-Json
$date = '2025-12-08'
foreach ($t in $techs) {
    $user = $t.tech
    $pass = $t.password
    Write-Output "---- Fetching live for $user ----"
    $body = @{ user = $user; pass = $pass } | ConvertTo-Json
    try {
        $res = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/technet/live' -Body $body -ContentType 'application/json' -TimeoutSec 180
        $outdir = Join-Path (Get-Location) "cache\live\$user"
        New-Item -ItemType Directory -Path $outdir -Force | Out-Null
        $outfile = Join-Path $outdir "$date.json"
        $res | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 $outfile
        Write-Output "Saved $outfile (mode=$($res.mode))"
    } catch {
        Write-Output ("Error fetching " + $user + ": " + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 300
}
Write-Output 'Fetch loop complete.'
