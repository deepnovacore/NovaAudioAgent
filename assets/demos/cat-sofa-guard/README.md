# Guard Cat-Sofa Example

This small public fixture demonstrates file-backed visual observation without a live camera. The
video shows a static sofa scene with a cat entering the monitored area. `first.png` and `last.png`
provide convenient boundary frames for documentation and manual inspection.

Run the live Guard evaluator with an absolute file source and local artifact directory:

```bash
uv sync --extra vision --dev
uv run python scripts/eval_watch_alert.py \
  --mode guard \
  --video-file /absolute/path/to/assets/demos/cat-sofa-guard/cat-sofa-guard.mp4 \
  --artifacts /tmp/nova-audio-agent-cat-sofa-guard
```

The evaluator requires model credentials. Visual content is treated as untrusted evidence; text
visible inside a frame is never interpreted as an instruction.
