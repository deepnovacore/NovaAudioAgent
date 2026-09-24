import asyncio,json,time,sys
from pathlib import Path
import numpy as np
import websockets
from faster_whisper.audio import decode_audio
r=Path(sys.argv[1])
normalize=lambda text: ''.join(c.lower() for c in text if c.isalnum())
async def case(name,a):
 rows=[]
 async with websockets.connect('ws://127.0.0.1:18102/v1/audio/stream') as ws:
  await ws.recv();start=time.perf_counter()
  async def read():
   async for raw in ws:
    row=json.loads(raw);row['ms']=(time.perf_counter()-start)*1000;rows.append(row)
  reading=asyncio.create_task(read())
  pcm=(np.clip(a,-1,1)*32767).astype('<i2').tobytes()
  for i in range(0,len(pcm),640):
   await ws.send(pcm[i:i+640]);await asyncio.sleep(max(0,start+(i+640)/32000-time.perf_counter()))
  end=(time.perf_counter()-start)*1000;await ws.send('finish');await asyncio.wait_for(reading,15)
 return dict(name=name,end_ms=end,events=rows)
async def main():
 a=decode_audio(str(r/'clean-zh.wav'));b=decode_audio(str(r/'jfk.flac'))
 rows=[]
 for name,x in [('zh',a),('en',b),('mixed',np.concatenate([a,np.zeros(8000,np.float32),b])),('silence',np.zeros(48000,np.float32))]:
  row=await case(name,x);rows.append(row)
  finals=[e for e in row['events'] if e.get('final')]
  assert len(finals)==1, row
  zh='欢迎大家来体验达摩院推出的语音识别模型'
  en='And so my fellow Americans ask not what your country can do for you ask what you can do for your country'
  expected={'zh':zh,'en':en,'mixed':zh+en,'silence':''}[name]
  assert normalize(finals[0]['text'])==normalize(expected), row
  if name!='silence': assert any(not e.get('final') and e['ms']<row['end_ms'] for e in row['events']), row
  print(json.dumps(row,ensure_ascii=False),flush=True)
 (r/'live-sidecar.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
asyncio.run(main())
