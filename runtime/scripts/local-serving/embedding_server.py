"""CPU-only OpenAI-compatible Qwen embedding endpoint for local memory."""
import os
from contextlib import asynccontextmanager

os.environ['CUDA_VISIBLE_DEVICES'] = ''
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModel, AutoTokenizer

MODEL = os.environ['EMBEDDING_MODEL_PATH']
NAME = 'Qwen/Qwen3-Embedding-0.6B'
_tokenizer = _model = None


@asynccontextmanager
async def lifespan(app):
    global _tokenizer, _model
    torch.set_num_threads(4)
    _tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True, padding_side='left')
    _model = AutoModel.from_pretrained(MODEL, local_files_only=True).to('cpu').eval()
    yield


app = FastAPI(lifespan=lifespan)


class Request(BaseModel):
    model: str
    input: str | list[str]
    dimensions: int = Field(default=1024, ge=1, le=1024)
    encoding_format: str = 'float'


@app.get('/health')
def health():
    return {'ready': _model is not None, 'device': 'cpu'}


@app.post('/v1/embeddings')
def embed(body: Request):
    texts = [body.input] if isinstance(body.input, str) else body.input
    if body.model != NAME or body.encoding_format != 'float' or not 1 <= len(texts) <= 10 or any(not t or len(t) > 32768 for t in texts):
        raise HTTPException(400, 'invalid embedding request')
    encoded = _tokenizer(texts, padding=True, return_tensors='pt', truncation=False)
    if encoded.input_ids.shape[1] > 8192:
        raise HTTPException(413, 'embedding input exceeds serving token budget')
    with torch.inference_mode():
        vectors = _model(**encoded).last_hidden_state[:, -1, :body.dimensions]
        vectors = torch.nn.functional.normalize(vectors, p=2, dim=1)
    return {'object': 'list', 'model': NAME, 'data': [
        {'object': 'embedding', 'index': i, 'embedding': v} for i, v in enumerate(vectors.tolist())],
        'usage': {'prompt_tokens': int(encoded.attention_mask.sum()), 'total_tokens': int(encoded.attention_mask.sum())}}
