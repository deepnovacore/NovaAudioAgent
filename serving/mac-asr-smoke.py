"""Offline CPU ASR check using an existing openai-whisper environment and weights."""
import argparse
import json
from pathlib import Path
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', required=True, type=Path, help='Existing Whisper .pt weights; never downloads')
parser.add_argument('--audio', required=True, type=Path, help='Prerecorded/synthetic audio; no microphone capture')
parser.add_argument('--language', default='zh')
parser.add_argument('--expect', help='Required substring for a known synthetic fixture')
args = parser.parse_args()
if not args.model.is_file() or not args.audio.is_file():
    parser.error('model and audio must be existing files')

import whisper

started = time.monotonic()
model = whisper.load_model(str(args.model.resolve()), device='cpu')
result = model.transcribe(str(args.audio.resolve()), language=args.language, fp16=False)
text = result['text'].strip()
if not text:
    raise RuntimeError('Local ASR produced an empty transcript')
if args.expect and args.expect not in text:
    raise RuntimeError('Local ASR transcript did not match the synthetic fixture')
print(json.dumps({'mode': 'real-local-asr', 'device': 'cpu', 'microphone': False,
                  'characters': len(text), 'expectedMatch': True if args.expect else None,
                  'seconds': round(time.monotonic() - started, 2)}))
