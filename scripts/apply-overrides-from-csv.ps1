param(
  [Parameter(Mandatory=$true)] [string]$CsvPath,
  [Parameter(Mandatory=$false)] [string]$ServerUrl = 'http://localhost:3000',
  [Parameter(Mandatory=$false)] [string]$AdminUser = 'admin',
  [Parameter(Mandatory=$false)] [string]$AdminPass = 'admin'
)

if (-not (Test-Path $CsvPath)) { Write-Error "CSV not found: $CsvPath"; exit 1 }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ username = $AdminUser; password = $AdminPass } | ConvertTo-Json
Invoke-RestMethod -Uri "$ServerUrl/api/admin/login" -Method Post -Body $loginBody -ContentType 'application/json' -WebSession $session

Import-Csv -Path $CsvPath | ForEach-Object {
  $job = $_.job
  $address = $_.address
  $lat = $_.lat
  $lng = $_.lng
  if (-not $address -or -not $lat -or -not $lng) { Write-Warning "Skipping invalid row: $($_ | ConvertTo-Json -Compress)"; return }
  $body = @{ address = $address; job = $job; lat = [double]$lat; lng = [double]$lng } | ConvertTo-Json
  try {
    $res = Invoke-RestMethod -Uri "$ServerUrl/api/geocode/override" -Method Post -Body $body -ContentType 'application/json' -WebSession $session -TimeoutSec 60
    Write-Output "OVERRIDDEN: job=$job address='$address' -> $($res.point.lat),$($res.point.lng)"
  } catch {
    Write-Warning "FAILED override for job=$job address='$address' -> $_"
  }
}
