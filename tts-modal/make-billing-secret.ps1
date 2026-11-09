# PC の Modal のトークン（1-login.bat で ~/.modal.toml に入ったもの）を、Secret「modal-billing」にコピーする。
# 今月の使用量の窓口（usage）が料金を読むために使う。トークンは画面にもファイルにも出さない。
$f = Join-Path $env:USERPROFILE '.modal.toml'
if (-not (Test-Path -LiteralPath $f)) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
$text = Get-Content -LiteralPath $f -Raw -Encoding UTF8
# [profile] ごとに分けて、active = true のもの（無ければ最初）を使う
$blocks = [regex]::Split($text, '(?m)^\s*\[') | Where-Object { $_ -match 'token_id' }
if (-not $blocks) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
$pick = $blocks | Where-Object { $_ -match '(?m)^\s*active\s*=\s*true' } | Select-Object -First 1
if (-not $pick) { $pick = $blocks | Select-Object -First 1 }
$id  = [regex]::Match($pick, 'token_id\s*=\s*"([^"]+)"').Groups[1].Value
$sec = [regex]::Match($pick, 'token_secret\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $id -or -not $sec) { Write-Host 'Modal token not found. Run 1-login.bat first.'; exit 1 }
& uvx modal secret create modal-billing "BILLING_TOKEN_ID=$id" "BILLING_TOKEN_SECRET=$sec" --force | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "OK: secret 'modal-billing' saved." } else { Write-Host 'Failed to save the secret.'; exit 1 }
