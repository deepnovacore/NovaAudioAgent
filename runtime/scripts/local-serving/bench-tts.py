"""Real HTTP wall-clock RTF, including input preparation and complete PCM delivery."""
import json
import pathlib
import sys
import time
import wave
import requests

out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
texts = [
    ('short-1', '你好，这是本地语音合成验收。'),
    ('short-repeat', '你好，这是本地语音合成验收。'),
    ('medium', '今天我们测试完全在本地运行的语音助手。语音识别、语言模型和语音合成分别作为独立服务运行，记忆也保存在本地。'),
]
results = []
for name, text in texts:
    begin = time.perf_counter()
    first = None
    chunks = []
    with requests.post('http://127.0.0.1:18103/v1/audio/speech',
                       data={'text': text, 'instruction': '自然、清晰的中文语音'},
                       stream=True, timeout=(5, 120)) as response:
        response.raise_for_status()
        assert response.headers.get('X-Sample-Rate') == '24000'
        assert response.headers.get('X-Sample-Format') == 's16le'
        for chunk in response.iter_content(chunk_size=None):
            if chunk:
                if first is None:
                    first = time.perf_counter() - begin
                chunks.append(chunk)
    elapsed = time.perf_counter() - begin
    pcm = b''.join(chunks)
    assert pcm and len(pcm) % 2 == 0
    seconds = len(pcm) / 48000
    row = {'name': name, 'text': text, 'characters': len(text), 'first_audio_seconds': first,
           'wall_seconds': elapsed, 'audio_seconds': seconds, 'rtf': elapsed / seconds,
           'pcm_bytes': len(pcm)}
    results.append(row)
    with wave.open(str(out / (name + '.wav')), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000); wav.writeframes(pcm)
    (out / 'rtf.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(row, ensure_ascii=False), flush=True)
