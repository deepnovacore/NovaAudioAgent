"""Single-request CocktailASR HTTP service. Bind loopback; use a tunnel remotely."""
import io
import os
import threading
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from transformers import AutoModel

MODEL = os.environ['COCKTAIL_MODEL_PATH']
_lock = threading.Lock()
_model = None


def decode(payload, max_seconds):
    if len(payload) > 2_000_000:
        raise HTTPException(413, 'audio too large')
    try:
        audio, rate = sf.read(io.BytesIO(payload), dtype='float32')
    except Exception as exc:
        raise HTTPException(400, 'invalid WAV') from exc
    if rate != 16000 or audio.ndim != 1 or not 0 < len(audio) <= rate * max_seconds or not np.isfinite(audio).all():
        raise HTTPException(400, 'expected bounded mono 16kHz WAV')
    return audio


@asynccontextmanager
async def lifespan(app):
    global _model
    # Use a pinned, pre-downloaded local directory; no runtime model downloads.
    _model = AutoModel.from_pretrained(MODEL, trust_remote_code=True, local_files_only=True,
                                      torch_dtype=torch.bfloat16).to('cuda:0').eval()
    yield
    _model = None


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health():
    return {'ready': _model is not None, 'input_sample_rate': 16000, 'streaming': False}


@app.post('/v1/audio/transcriptions')
async def transcribe(file: UploadFile = File(...), reference_audio: UploadFile = File(...)):
    # Bound reads before decode; references are audio bytes, never server paths/URLs.
    target = decode(await file.read(2_000_001), 60)
    reference = decode(await reference_audio.read(2_000_001), 4)
    if len(reference) < 16000:
        raise HTTPException(400, 'reference must contain 1 to 4 seconds')
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, 'ASR busy')
    def infer():
        try:
            with torch.inference_mode():
                text = _model(target, reference)
            if not isinstance(text, str) or len(text) > 4000:
                raise RuntimeError('invalid model transcript')
            return {'text': text}
        finally:
            _lock.release()
    # The upstream model has no proven cancellation interface. A disconnected request
    # completes this bounded utterance; admission stays locked until GPU work ends.
    return await run_in_threadpool(infer)
