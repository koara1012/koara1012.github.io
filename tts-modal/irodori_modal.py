"""
Irodori-TTS-Server を Modal（クラウドGPU）で動かすためのファイル。
キャラチャット（トーク／ノベル画面）の「読み上げ」の声のサーバーとして使う。

使いかたは同じフォルダの README.md を見てください。
  1回目：  modal deploy irodori_modal.py
  声の更新：modal volume put irodori-voices <voicesフォルダ> / --force

・合言葉（IRODORI_API_KEY）は Modal の Secret「irodori-tts」に入れる。このファイルには書かない（公開リポジトリのため）
・お手本の声は Volume「irodori-voices」（中の /voices フォルダ）に置く
・モデルは Volume「irodori-hf-cache」に、最初に起動したときに自動でダウンロードされて残る
"""

import subprocess

import modal

# ---- ここだけ変えれば調整できます ---------------------------------------
GPU = "L4"                 # 24GB。Irodori-TTS には十分。安くしたいときは "T4"（未確認）
SCALEDOWN_SECONDS = 240    # 最後の声を作ってから、GPU を止めるまで待つ秒数（この間も料金がかかる）。
                           # 短いほど安いが、次に話しかけたとき起動待ち（30秒〜1分）になりやすい
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
        "cd /app && uv sync --locked --no-dev --no-editable --extra cu128 --python 3.10",
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
    max_containers=1,                 # GPU を2台以上起こさない（料金が倍にならないように）
    scaledown_window=SCALEDOWN_SECONDS,
    timeout=600,                      # 1回目はモデルのダウンロードで長くかかるので余裕を持たせる
)
@modal.concurrent(max_inputs=8)       # 声の頼みが重なっても同じ GPU で順番に作る（サーバー側が1つずつ作る）
@modal.web_server(PORT, startup_timeout=900)
def serve():
    # モデルを読み終えてから受け付けを始める（IRODORI_PRELOAD=true）。
    # 1回目だけ、モデルを Volume にダウンロードするので数分かかる
    subprocess.Popen(["/app/.venv/bin/python", "-m", "irodori_openai_tts"], cwd="/app")
