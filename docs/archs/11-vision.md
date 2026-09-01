# 11. Vision

Vision uses the same executor and media boundaries as other capabilities. A frame source captures a
bounded image, `MediaStore` assigns a reference, and model-facing state carries that reference rather
than a local filesystem path.

`cam.snapshot` is pull-shaped. Watch and Guard add repeated observation with different attention and
preemption policy while preserving the same untrusted-evidence rule. Text visible inside an image is
never an instruction.

Supported sources are disabled, a local camera through Chromium's capture pipeline, and an explicit
video file. File sources are
useful for deterministic demonstrations such as the
[cat-sofa fixture](../../assets/demos/cat-sofa-guard/README.md).
