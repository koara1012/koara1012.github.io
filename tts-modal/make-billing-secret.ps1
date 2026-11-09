# Copy this PC's Modal token (saved in ~/.modal.toml by 1-login.bat) to the Modal secret "modal-billing".
# The usage endpoint uses it to read this month's cost. The token is never printed or written to a file.
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as Shift-JIS.)
$f = Join-Path $env:USERPROFILE '.modal.toml'
if (-not (Test-Path -LiteralPath $f)) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
$text = Get-Content -LiteralPath $f -Raw -Encoding UTF8
# Split by [profile]; use the one with active = true (or the first one)
$blocks = [regex]::Split($text, '(?m)^\s*\[') | Where-Object { $_ -match 'token_id' }
if (-not $blocks) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
$pick = $blocks | Where-Object { $_ -match '(?m)^\s*active\s*=\s*true' } | Select-Object -First 1
if (-not $pick) { $pick = $blocks | Select-Object -First 1 }
$id  = [regex]::Match($pick, 'token_id\s*=\s*"([^"]+)"').Groups[1].Value
$sec = [regex]::Match($pick, 'token_secret\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $id -or -not $sec) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
& uvx modal secret create modal-billing "BILLING_TOKEN_ID=$id" "BILLING_TOKEN_SECRET=$sec" --force | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "OK: secret 'modal-billing' saved." } else { Write-Host 'Failed to save the secret.'; exit 1 }
