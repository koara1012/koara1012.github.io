"""
Irodori-TTS-Server を Modal（クラウドGPU）で動かすためのファイル。
キャラチャット（トーク／ノベル画面）の「読み上げ」の声のサーバーとして使う。

使いかたは同じフォルダの README.md を見てください。
  1回目：  modal deploy irodori_modal.py
  声の更新：modal volume put irodori-voices <voicesフォルダ> / --force

・合言葉（IRODORI_API_KEY）は Modal の Secret「irodori-tts」に入れる。このファイルには書かない（公開リポジトリのため）
・お手本の声は Volume「irodori-voices」（中の /voices フォルダ）に置く
・モデルは Volume「irodori-hf-cache」に、最初に起動したときに自動でダウンロードされて残る
・今月の使用量の窓口（usage）：GPU を使わない小さな関数。料金を読むために、PC の Modal のトークンを
  Secret「modal-billing」に入れて使う（5-usage-setup.bat で作る）。アプリの設定の「読み上げ」に出す
"""

import subprocess

import modal

# ---- ここだけ変えれば調整できます ---------------------------------------
GPU = ["L4", "A10", "T4"]  # 使う GPU（左から順に試す）。L4（24GB・約0.80ドル/時）が借りられないときは A10（約1.10ドル/時）、
                           # それも無ければ T4（約0.59ドル/時・少し遅い）。2026-11-11 に L4 が空かず、声の頼みが何分も順番待ちのまま
                           # 起動しなかったので、代わりを足した。L4 だけにしたいときは GPU = "L4"
SCALEDOWN_SECONDS = 30     # 最後の頼みから GPU を止めるまでの秒数（この間も料金がかかる）。
                           # 2026-11-10 から30秒：アプリが使っている間（ノベル画面で最後に話してから4分・電話中）は
                           # 20秒ごとに /health で起こし続けるので、拒否・スルー・アプリを閉じたときだけ早く止まる
MONTHLY_CREDITS = 30       # Starter の毎月の無料分（ドル）。アプリの「あと〇ドル」の計算に使う
HOURLY_ESTIMATE = 0.85     # L4＋CPU＋メモリで1時間あたりのおおよその料金（ドル）。「あと約〇時間」の目安
PRECISION = "fp32"         # PC と同じ。軽くしたいときは "bf16"（Irodori の Docker GPU 設定はこちら）。声は少し変わるかも
ALLOWED_ORIGIN = "https://koara1012.github.io"
# Irodori-TTS-Server の版（2026-11-04 の版に固定。勝手に変わらないように）
IRODORI_SERVER_REPO = "https://github.com/Aratako/Irodori-TTS-Server"
IRODORI_SERVER_REV = "ce06bebd0ed243cc0fb6999ef7827b6e45d0d9d2"
# ------------------------------------------------------------------------

PORT = 8088
HF_CACHE = "/root/.cache/huggingface"
VOICE_VOL_PATH = "/data"            # Volume「irodori-voices」をここに付ける
VOICES_DIR = VOICE_VOL_PATH + "/voices"  # `modal volume put irodori-voices ...\voices /` で入る場所

app = modal.App("irodori-tts")

hf_cache = modal.Volume.from_name("irodori-hf-cache", create_if_missing=True)
voices = modal.Volume.from_name("irodori-voices", create_if_missing=True)

# Irodori-TTS-Server の Dockerfile と同じ手順で入れる（uv・CUDA 12.8 版の PyTorch）
# Modal の土台は 3.11 以上しか選べないので 3.11。サーバー本体は uv が Python 3.10（リポジトリの .python-version）を
# 自分で取ってきて /app/.venv に入れる（PC と同じ 3.10 で動く）
# --locked だと Modal の中では「uv.lock を作り直して」と止まるので、--frozen（uv.lock の版をそのまま入れる）
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("build-essential", "ca-certificates", "ffmpeg", "git", "libsndfile1")
    .pip_install("uv")
    .env({
        "PYTHONUNBUFFERED": "1",
        "UV_LINK_MODE": "copy",
        "UV_PROJECT_ENVIRONMENT": "/app/.venv",
    })
    .run_commands(
        f"git clone {IRODORI_SERVER_REPO} /app",
        f"cd /app && git checkout {IRODORI_SERVER_REV}",
        "cd /app && uv sync --frozen --no-dev --no-editable --extra cu128 --python 3.10",
    )
    .env({
        "HF_HOME": HF_CACHE,
        "IRODORI_HOST": "0.0.0.0",
        "IRODORI_PORT": str(PORT),
        "IRODORI_MODEL_NAME": "irodori-tts",
        "IRODORI_HF_CHECKPOINT": "Aratako/Irodori-TTS-v4.1-Small-MF",
        "IRODORI_CODEC_REPO": "Aratako/Semantic-DACVAE-Japanese-32dim",
        "IRODORI_MODEL_DEVICE": "cuda",
        "IRODORI_CODEC_DEVICE": "cuda",
        "IRODORI_MODEL_PRECISION": PRECISION,
        "IRODORI_CODEC_PRECISION": PRECISION,
        "IRODORI_PRELOAD": "true",
        "IRODORI_VOICES_DIR": VOICES_DIR,
        "IRODORI_DEFAULT_RESPONSE_FORMAT": "wav",
        "IRODORI_CORS_ORIGINS": f'["{ALLOWED_ORIGIN}"]',
    })
)


@app.function(
    image=image,
    gpu=GPU,
    volumes={HF_CACHE: hf_cache, VOICE_VOL_PATH: voices},
    secrets=[modal.Secret.from_name("irodori-tts")],   # IRODORI_API_KEY=合言葉
    max_containers=2,                 # ふだんは1台（声の頼みは1台で8つまで同時に受ける）。2026-11-11：1 にしていたら、GPU が一度止まったあと
                                      # 置き直すまで次が起動せず、頼みが Pending のままになった（止まった1台が残っている扱いになった疑い）ので、2 にして逃げ道を作る
    scaledown_window=SCALEDOWN_SECONDS,
    timeout=600,                      # 1回目はモデルのダウンロードで長くかかるので余裕を持たせる
)
@modal.concurrent(max_inputs=8)       # 声の頼みが重なっても同じ GPU で順番に作る（サーバー側が1つずつ作る）
@modal.web_server(PORT, startup_timeout=900)
def serve():
    # モデルを読み終えてから受け付けを始める（IRODORI_PRELOAD=true）。
    # 1回目だけ、モデルを Volume にダウンロードするので数分かかる
    subprocess.Popen(["/app/.venv/bin/python", "-m", "irodori_openai_tts"], cwd="/app")


# ===== 今月の使用量（アプリの設定に出す）。GPU なし・すぐ止まるので、料金はほぼかからない =====
usage_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(
    image=usage_image,
    cpu=0.25,
    memory=256,
    secrets=[modal.Secret.from_name("irodori-tts"), modal.Secret.from_name("modal-billing")],
    max_containers=1,
    scaledown_window=10,
    timeout=60,
)
@modal.asgi_app()
def usage():
    import os
    import time
    from datetime import datetime, timezone

    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse

    web = FastAPI()
    web.add_middleware(CORSMiddleware, allow_origins=[ALLOWED_ORIGIN], allow_methods=["GET"], allow_headers=["Authorization"])
    cache = {"at": 0.0, "body": None}

    def read_summary():
        # まずコンテナ自身の権限で。だめなら PC のトークン（Secret「modal-billing」）で
        errors = []
        try:
            return modal.Workspace.from_context().billing.summary(cycle="this month")
        except Exception as e:  # noqa: BLE001
            errors.append(f"container: {type(e).__name__}: {e}")
        tid, tsec = os.environ.get("BILLING_TOKEN_ID"), os.environ.get("BILLING_TOKEN_SECRET")
        if tid and tsec:
            try:
                client = modal.Client.from_credentials(tid, tsec)
                return modal.Workspace.from_context(client=client).billing.summary(cycle="this month")
            except Exception as e:  # noqa: BLE001
                errors.append(f"token: {type(e).__name__}: {e}")
        raise RuntimeError(" / ".join(errors) or "no credentials")

    @web.get("/")
    def get_usage(request: Request):
        key = os.environ.get("IRODORI_API_KEY", "")
        if not key or request.headers.get("authorization", "") != f"Bearer {key}":
            return JSONResponse({"error": "bad passphrase"}, status_code=401)
        if cache["body"] and time.time() - cache["at"] < 60:
            return cache["body"]
        try:
            s = read_summary()
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)[:400]}, status_code=502)
        metered = float(s.metered_cost)
        body = {
            "month": datetime.now(timezone.utc).strftime("%Y-%m"),
            "metered": round(metered, 4),            # 今月使った分（無料分を引く前）
            "billed": round(float(s.billed_cost), 4),  # 実際に請求される分（spend limit 0 なら 0 のはず）
            "credits": MONTHLY_CREDITS,
            "remaining": round(max(0.0, MONTHLY_CREDITS - metered), 4),
            "hourly_estimate": HOURLY_ESTIMATE,
            "breakdown": {k: round(float(v), 4) for k, v in s.metered_cost_breakdown.items() if float(v)},
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        cache.update(at=time.time(), body=body)
        return body

    return web
