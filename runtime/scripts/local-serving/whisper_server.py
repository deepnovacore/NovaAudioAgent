"""Bounded, utterance-scoped faster-whisper streaming. Loopback + SSH tunnel only."""
import asyncio
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps

RATE = 16000
MAX_BYTES = RATE * 2 * 65  # 60s speech cap plus pre-roll/frame alignment
MIN_SPEECH = float(os.getenv('ASR_MIN_SPEECH_SECONDS', '0.8'))
INTERVAL = float(os.getenv('ASR_PARTIAL_INTERVAL_SECONDS', '0.20'))
_model = None
_busy = False
_vad = VadOptions(min_silence_duration_ms=500, speech_pad_ms=200,
                  max_speech_duration_s=20)


@asynccontextmanager
async def lifespan(app):
    global _model
    _model = WhisperModel(os.environ['WHISPER_MODEL_PATH'], device='cuda',
                          compute_type=os.getenv('ASR_COMPUTE_TYPE', 'float16'),
                          local_files_only=True)
    # Consume the lazy iterator: loading weights alone does not warm CUDA kernels.
    for language in ('zh', 'en'):
        segments, _ = _model.transcribe(np.zeros(RATE, np.float32), language=language,
                                       beam_size=1, temperature=0)
        list(segments)
    get_speech_timestamps(np.zeros(RATE, np.float32), _vad)
    yield
    _model = None


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health():
    return dict(ready=_model is not None, streaming=True, device='cuda',
                compute_type=os.getenv('ASR_COMPUTE_TYPE', 'float16'), busy=_busy)


def recognize(pcm, final, cache):
    started = time.perf_counter()
    audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
    spans = get_speech_timestamps(audio, _vad)
    texts = []
    for span in spans:
        start, end = span['start'], span['end']
        closed = final or len(audio) - end >= int(.5 * RATE)
        key = (start, end)
        if key in cache:
            texts.append(cache[key])
            continue
        chunk = audio[start:end]
        if not closed and len(chunk) < (MIN_SPEECH + .2) * RATE:
            continue
        language, probability, probs = _model.detect_language(audio=chunk)
        candidates = [(lang, p) for lang, p in probs if lang in ('zh', 'en')]
        # Language probabilities are not speech confidence; VAD gates first.
        if sum(p for _, p in candidates) < .5:
            if closed:
                raise ValueError('uncertain Chinese/English language')
            continue
        language = max(candidates, key=lambda item: item[1])[0]
        segments, _ = _model.transcribe(chunk, language=language, beam_size=5 if closed else 1,
                                        temperature=0, condition_on_previous_text=False,
                                        vad_filter=False)
        text = ''.join(segment.text for segment in segments).strip()
        if closed:
            cache[key] = text
        texts.append(text)
    text = ' '.join(t for t in texts if t)
    if len(text) > 4000:
        raise ValueError('transcript too long')
    return dict(text=text, final=final, replace=True, audioMs=len(audio)/16,
                inferenceMs=(time.perf_counter()-started)*1000)


@app.websocket('/v1/audio/stream')
async def stream(ws: WebSocket):
    global _busy
    await ws.accept()
    # ponytail: one admitted utterance; add scheduling only for measured concurrency needs.
    if _busy:
        await ws.close(code=1013, reason='ASR busy')
        return
    _busy = True
    audio = bytearray()
    changed = asyncio.Event()
    finished = False
    stopped = False
    cache = {}
    worker = None

    async def decode_loop():
        last_text = None
        while not stopped:
            await changed.wait()
            if stopped:
                return
            changed.clear()
            is_final = finished
            began = time.perf_counter()
            snapshot = bytes(audio)
            result = await asyncio.to_thread(recognize, snapshot, is_final, cache)
            if stopped:
                return
            if is_final or (result['text'] and result['text'] != last_text):
                await ws.send_json(result)
                last_text = result['text']
            if is_final:
                return
            # Coalesce incoming frames while busy: never enqueue stale decode jobs.
            if not finished:
                await asyncio.sleep(max(0, INTERVAL - (time.perf_counter()-began)))

    try:
        await ws.send_json(dict(type='ready', sampleRate=RATE, format='s16le'))
        worker = asyncio.create_task(decode_loop())
        async with asyncio.timeout(120):
            while not finished:
                receiving = asyncio.create_task(ws.receive())
                done, _ = await asyncio.wait([receiving, worker], return_when=asyncio.FIRST_COMPLETED)
                if worker in done:
                    receiving.cancel()
                    await asyncio.gather(receiving, return_exceptions=True)
                    await worker
                    break
                message = receiving.result()
                if message['type'] == 'websocket.disconnect':
                    raise WebSocketDisconnect()
                data = message.get('bytes')
                if data is not None:
                    if not data or len(data) % 2 or len(data) > 64000 or len(audio)+len(data) > MAX_BYTES:
                        raise ValueError('expected bounded mono 16kHz s16le audio')
                    audio.extend(data)
                elif message.get('text') == 'finish':
                    if not audio:
                        raise ValueError('empty audio')
                    finished = True
                else:
                    raise ValueError('invalid control message')
                changed.set()
            await asyncio.shield(worker)
        await ws.close()
    except WebSocketDisconnect:
        pass
    except Exception as error:
        try:
            await ws.send_json(dict(error=str(error)))
            await ws.close(code=1011)
        except Exception:
            pass
    finally:
        stopped = True
        changed.set()
        # CT2 cannot cancel an in-flight kernel: retain admission until it exits.
        if worker:
            await asyncio.gather(worker, return_exceptions=True)
        _busy = False
