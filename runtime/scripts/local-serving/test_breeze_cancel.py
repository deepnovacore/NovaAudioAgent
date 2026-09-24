"""Run with patched Breeze source on PYTHONPATH; no model or GPU load needed."""
import asyncio
from breeze_infer.api import ClosingStreamingResponse

async def check(disconnect_before_body):
    releases = []
    def body():
        yield b'first'
        yield b'late'
    source = body()
    response = ClosingStreamingResponse(source, cleanup=lambda: releases.append(True))
    async def receive():
        return {'type': 'http.disconnect'}
    async def send(message):
        if disconnect_before_body or message['type'] == 'http.response.body':
            raise OSError('disconnected')
    try:
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)
    except OSError:
        pass
    except Exception as error:
        assert type(error).__name__ == 'ClientDisconnect', error
    assert releases == [True]
    assert list(source) == [], 'response did not close its source'

asyncio.run(check(False))
asyncio.run(check(True))
print('Breeze disconnect cleanup passed')
