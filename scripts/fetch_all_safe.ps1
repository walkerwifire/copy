param(
    [switch]$Promote,
    [int]$TimeoutSec = 180,
    [string]$Date = (Get-Date).ToString('yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'
$root = Get-Location
$techsPath = Join-Path $root 'techs.json'
if (-not (Test-Path $techsPath)) { Write-Error "Cannot find $techsPath"; exit 2 }
$techs = Get-Content $techsPath | ConvertFrom-Json
$ts = Get-Date -Format yyyyMMdd_HHmmss
$pending = Join-Path $root "tmp\pending_live_${Date}_$ts"
New-Item -ItemType Directory -Path $pending -Force | Out-Null

Write-Output "Pending directory: $pending"

# Fetch into pending folder
foreach ($t in $techs) {
    $user = $t.tech
    $pass = $t.password
    Write-Output "Fetching live for $user..."
    $body = @{ user = $user; pass = $pass } | ConvertTo-Json
    try {
        $res = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/technet/live' -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
        $outdir = Join-Path $pending "cache\live\$user"
        New-Item -ItemType Directory -Path $outdir -Force | Out-Null
        $outfile = Join-Path $outdir "$Date.json"
        $res | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 $outfile
        Write-Output "Saved $outfile (mode=$($res.mode))"
    } catch {
        Write-Output ("Error fetching " + $user + ": " + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 300
}

# Summary
$files = Get-ChildItem -Recurse -File $pending | Where-Object { $_.Name -eq "$Date.json" }
Write-Output "Fetched files: $($files.Count) -> $pending"

if (-not $Promote) {
    Write-Output "Dry run complete. To apply results and overwrite existing caches run this script again with -Promote." 
    exit 0
}

# Promote: backup existing files then move pending into place
$bak = Join-Path $root "tmp\backup_live_${Date}_$ts"
New-Item -ItemType Directory -Path $bak -Force | Out-Null

# Move existing per-tech files into backup
Get-ChildItem -Recurse -File (Join-Path $root 'cache\live') -Filter "$Date.json" -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($root.Path.Length).TrimStart('\')
    $dest = Join-Path $bak ($rel -replace '[\\:]','_')
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Move-Item -Path $_.FullName -Destination $dest -Force
    Write-Output "Backed up existing: $($_.FullName) -> $dest"
}

# Backup aggregated file if exists
$agg = Join-Path $root "data\stops-$Date.json"
if (Test-Path $agg) {
    $destAgg = Join-Path $bak "stops-$Date.json"
    Move-Item -Path $agg -Destination $destAgg -Force
    Write-Output "Backed up aggregated file: $agg -> $destAgg"
}

# Promote pending files into cache/live
Get-ChildItem -Recurse -File $pending | ForEach-Object {
    $rel = $_.FullName.Substring($pending.Length).TrimStart('\')
    $target = Join-Path $root $rel
    $targetDir = Split-Path $target
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Move-Item -Path $_.FullName -Destination $target -Force
    Write-Output "Promoted: $($_.FullName) -> $target"
}

# Regenerate aggregation
Write-Output "Refreshing aggregated file via server API..."
$b = @{ date = $Date } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/refresh' -Body $b -ContentType 'application/json' -TimeoutSec $TimeoutSec | ConvertTo-Json -Depth 5 | Write-Output

Write-Output "Promotion complete. Backup is at: $bak"
