param(
  [string]$RemoteTarget = 'root@185.8.213.144',
  [string]$LiveUrl = 'https://nemo.185.8.213.144.sslip.io',
  [string]$SshKey = (Join-Path $env:USERPROFILE '.ssh\nemo_deploy_ed25519')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$dist = [IO.Path]::GetFullPath((Join-Path $root 'dist'))
if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) {
  throw 'dist/index.html is missing. Run npm run build first.'
}
if (-not (Test-Path -LiteralPath $SshKey)) {
  throw "SSH key is missing: $SshKey"
}

$releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
$releaseDir = "/var/www/nemo-releases/$releaseId"
$previousRelease = (ssh -i $SshKey -o BatchMode=yes $RemoteTarget 'readlink -f /var/www/nemo-current').Trim()
if ($previousRelease -notmatch '^/var/www/nemo-releases/[0-9]{8}-[0-9]{6}$') {
  throw "Unexpected current release target: $previousRelease"
}

ssh -i $SshKey -o BatchMode=yes $RemoteTarget "mkdir -p '$releaseDir'"
if ($LASTEXITCODE -ne 0) { throw 'Could not create the release directory.' }

scp -i $SshKey -o BatchMode=yes -r (Join-Path $dist '*') "${RemoteTarget}:$releaseDir/"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload the release.' }

# Windows OpenSSH may preserve a restrictive local mode on directories. nginx
# must be able to traverse assets before the symlink is switched.
ssh -i $SshKey -o BatchMode=yes $RemoteTarget "chmod -R a+rX '$releaseDir' && test -s '$releaseDir/index.html' && test -d '$releaseDir/assets' && find '$releaseDir/assets' -maxdepth 1 -type f -name 'index-*.js' -readable | grep -q ."
if ($LASTEXITCODE -ne 0) {
  throw 'Uploaded release validation failed; the current symlink was not changed.'
}

ssh -i $SshKey -o BatchMode=yes $RemoteTarget "ln -sfn '$releaseDir' /var/www/nemo-current"
if ($LASTEXITCODE -ne 0) { throw 'Could not switch the release symlink.' }

try {
  $html = (Invoke-WebRequest -Uri "$LiveUrl/app/autonomous" -UseBasicParsing -TimeoutSec 20).Content
  $asset = [regex]::Match($html, 'src="([^"]+index-[^"]+\.js)"').Groups[1].Value
  if (-not $asset) { throw 'The deployed index does not reference a JS asset.' }
  $assetResponse = Invoke-WebRequest -Uri "$LiveUrl$asset" -UseBasicParsing -TimeoutSec 20
  if ($assetResponse.StatusCode -ne 200) { throw "The JS asset returned HTTP $($assetResponse.StatusCode)." }
} catch {
  ssh -i $SshKey -o BatchMode=yes $RemoteTarget "ln -sfn '$previousRelease' /var/www/nemo-current"
  throw "Release health check failed; rolled back to $previousRelease. $($_.Exception.Message)"
}

Write-Host "Atomic frontend release verified: $releaseDir" -ForegroundColor Green
Write-Host "Previous release retained: $previousRelease" -ForegroundColor DarkGray
