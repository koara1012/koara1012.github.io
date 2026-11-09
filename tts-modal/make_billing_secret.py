"""PC の Modal のトークン（modal setup で ~/.modal.toml に入ったもの）を、
Secret「modal-billing」にコピーする。今月の使用量を読む窓口（usage）が料金を読むために使う。
トークンはこの PC と Modal の中にだけ置かれ、ファイルやリポジトリには書かれない。"""
import subprocess
import sys

from modal.config import config

tid, tsec = config.get("token_id"), config.get("token_secret")
if not tid or not tsec:
    print("Modal token not found. Run 1-login.bat first.")
    sys.exit(1)
r = subprocess.run([sys.executable, "-m", "modal", "secret", "create", "modal-billing",
                    f"BILLING_TOKEN_ID={tid}", f"BILLING_TOKEN_SECRET={tsec}", "--force"],
                   capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout[-800:], r.stderr[-800:])
    sys.exit(r.returncode)
print("OK: secret 'modal-billing' saved.")
