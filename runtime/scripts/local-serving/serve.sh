#!/usr/bin/env bash
# One foreground process per service; use your normal supervisor for persistence.
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'Usage: serve.sh <llm|extraction|asr|tts|embedding> <experiment-root> <llm-gpu-index> <asr-gpu-index>' >&2
  exit 2
fi
service=$1
root=$(cd "$2" && pwd)
llm_gpu=$3
asr_gpu=$4
[[ "$llm_gpu" =~ ^[0-9]+$ && "$asr_gpu" =~ ^[0-9]+$ && "$llm_gpu" != "$asr_gpu" ]] || { echo 'Select two distinct physical GPU indices' >&2; exit 2; }
for gpu in "$llm_gpu" "$asr_gpu"; do
  gpu_name=$(nvidia-smi --id="$gpu" --query-gpu=name --format=csv,noheader)
  [[ "$gpu_name" == *'RTX 4090'* ]] || { echo 'This experimental budget is validated only on two RTX 4090s' >&2; exit 2; }
done
# nvidia-smi indices and CUDA ordinals are not interchangeable. Establish PCI
# order, then verify the CUDA UUID before loading any model weights.
export HF_HUB_OFFLINE=1 CUDA_DEVICE_ORDER=PCI_BUS_ID
cuda_ordinal() {
  nvidia-smi --query-gpu=pci.bus_id,index --format=csv,noheader | sort | awk -F', *' -v selected="$1" '$2 == selected {print NR-1}'
}
verify_gpu() {
  expected=$(nvidia-smi --id="$1" --query-gpu=uuid --format=csv,noheader)
  "$2" -c 'import sys,torch; actual=str(torch.cuda.get_device_properties(0).uuid); assert actual.removeprefix("GPU-").lower()==sys.argv[1].removeprefix("GPU-").lower(), "CUDA physical GPU mismatch"' "$expected"
}
case "$service" in
  llm|extraction)
    model_gpu=$llm_gpu
    model_port=18101
    model_context=8192
    if [[ "$service" == extraction ]]; then
      model_gpu=$asr_gpu
      model_port=18106
      model_context=4096
    fi
    export CUDA_VISIBLE_DEVICES="$(cuda_ordinal "$model_gpu")"
    verify_gpu "$model_gpu" "$root/env-llm/bin/python"
    exec "$root/env-llm/bin/python" -m vllm.entrypoints.openai.api_server \
      --model "$root/models/llm" --served-model-name Qwen/Qwen3.5-4B \
      --host 127.0.0.1 --port "$model_port" --max-model-len "$model_context" --max-num-seqs 1 \
      --gpu-memory-utilization 0.50 --enforce-eager --language-model-only \
      --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 \
      --default-chat-template-kwargs '{"enable_thinking":false}' ;;
  asr)
    export CUDA_VISIBLE_DEVICES="$(cuda_ordinal "$asr_gpu")" WHISPER_MODEL_PATH="$root/models/whisper"
    verify_gpu "$asr_gpu" "$root/env-asr/bin/python"
    exec "$root/env-asr/bin/python" -m uvicorn whisper_server:app --app-dir "$root/repo/runtime/scripts/local-serving" --host 127.0.0.1 --port 18102 ;;
  tts)
    export CUDA_VISIBLE_DEVICES="$(cuda_ordinal "$llm_gpu")" PYTHONPATH="$root/breeze-src"
    verify_gpu "$llm_gpu" "$root/env-tts/bin/python"
    exec "$root/env-tts/bin/python" -m breeze_infer.api "$root/models/breeze" --host 127.0.0.1 --port 18103 --fast-backbone-decode --fast-depth-decoder ;;
  embedding)
    export CUDA_VISIBLE_DEVICES='' EMBEDDING_MODEL_PATH="$root/models/embedding"
    exec "$root/env-asr/bin/python" -m uvicorn embedding_server:app --app-dir "$root/repo/runtime/scripts/local-serving" --host 127.0.0.1 --port 18104 ;;
  *) echo 'Unknown service' >&2; exit 2 ;;
esac
