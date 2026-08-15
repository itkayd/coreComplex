# Local speech setup (CosyVoice)

Synthetic Mandarin speech runs entirely on your own hardware. There is no API
key, no account and no metered service anywhere in this stack — the speech
service refuses to start if `DYR_COSYVOICE_URL` points at a known paid host.

> **Synthetic speech is never canonical.** Generated audio is a convenience for
> text that has no human recording. It cannot satisfy the canonical-audio gate,
> cannot open the listening channel, and is always labelled in the UI. See
> `docs/adr/0010-synthetic-speech-cosyvoice.md`.

## 1. Install CosyVoice

```bash
git clone --recursive https://github.com/QwenAudio/CosyVoice.git
cd CosyVoice
# If you forgot --recursive:
git submodule update --init --recursive

conda create -n cosyvoice -y python=3.10
conda activate cosyvoice
pip install -r requirements.txt
```

`pynini` can be awkward on some platforms; upstream recommends installing it via
conda (`conda install -y -c conda-forge pynini==2.1.5`) before `pip install`.

## 2. Get the model weights

Weights are large and are **never committed to this repository** — `models/` is
git-ignored. Download them into a local directory:

```python
# from the CosyVoice checkout, with the env active
from modelscope import snapshot_download
snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512',
                  local_dir='pretrained_models/Fun-CosyVoice3-0.5B-2512')
```

A HuggingFace mirror of the same model works equally well; point `--model_dir`
at whichever local directory you populated.

## 3. Start the CosyVoice FastAPI server

```bash
cd CosyVoice/runtime/python/fastapi
python server.py --port 50000 \
  --model_dir ../../../pretrained_models/Fun-CosyVoice3-0.5B-2512
```

This is CosyVoice's own runtime. It exposes `POST /inference_sft`
(`tts_text`, `spk_id`) and streams headerless PCM int16; the Dyr service frames
that into WAV/OGG.

## 4. Start the Dyr speech service

```bash
# from the CoreComplex repo root
DYR_COSYVOICE_URL=http://127.0.0.1:50000 \
DYR_COSYVOICE_MODEL=FunAudioLLM/Fun-CosyVoice3-0.5B-2512 \
DYR_SPEECH_CACHE_DIR=./.cache/speech \
npm run speech
```

Check it:

```bash
curl http://127.0.0.1:8730/speech/health

curl -X POST http://127.0.0.1:8730/speech/synthesise \
  -H 'content-type: application/json' \
  -d '{"text":"我明天下午要去银行取钱。","language":"zh-CN","voice":"default","speed":1.0}'
```

The response carries an `audioId` (a sha256 content address), a service-relative
`url`, and provenance that always reads `"sourceType": "synthetic"`.

## 5. Start the plain body

```bash
npm run build:pack                 # immutable, signed Core 60 artefact
npm run dev --workspace=@dyr/web   # http://localhost:5173
```

Answer a task, then press **“Hear it (generated voice)”** on the Result screen.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DYR_SERVICE_PORT` | `8730` | Port the Dyr speech service listens on |
| `DYR_COSYVOICE_URL` | `http://127.0.0.1:50000` | Local CosyVoice server (paid hosts refused) |
| `DYR_COSYVOICE_MODEL` | `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` | Model identity, recorded in provenance and cache keys |
| `DYR_COSYVOICE_MODEL_DIR` | `./models/cosyvoice` | Local weights directory (git-ignored) |
| `DYR_COSYVOICE_VOICE` | `中文女` | Default `spk_id` |
| `DYR_COSYVOICE_SAMPLE_RATE` | `22050` | Rate of CosyVoice's headerless PCM |
| `DYR_SPEECH_CACHE_DIR` | `./.cache/speech` | Generated audio cache |
| `DYR_SPEECH_FORMAT` | `ogg` | `ogg` (needs ffmpeg + libopus) or `wav` |
| `DYR_FFMPEG_PATH` | *unset* | ffmpeg binary for OGG encoding and speed baking |
| `DYR_SPEECH_MAX_TEXT` | `500` | Max characters per request |
| `DYR_ALLOWED_ORIGINS` | localhost 5173/4173 | Origins allowed to call the service |

**ffmpeg is optional.** Without it the service serves WAV at natural pace and
reports `speedApplied: false`; the PWA then applies a pitch-preserving
`playbackRate` instead of pretending the speed was baked in.

## Privacy

- Learner text goes only to your own machine.
- `audioId` is a content hash: no filesystem path reaches the browser.
- Generated audio is not kept forever — `SpeechCache.prune(maxAgeMs, now)`
  removes old entries; wire it to a schedule that suits you.
- Learner voice recordings are never used for training and are not touched by
  this service at all.

## Offline behaviour

- Already-generated clips replay from the browser's Cache API with no network.
- An uncached request while the service is down fails calmly: the UI says
  generated speech needs the local service, and the session continues.
- Canonical human recordings (when provisioned) are part of the content pack and
  are unaffected by any of this.
