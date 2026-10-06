#!/usr/bin/env python3
"""Linux model workers only. No dependency on Nova or its application state."""
import argparse
import json
import hashlib
import tempfile
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
BREEZE_COMMIT = '008f769016b0a24711becd7a4925030bc93f608c'


def load_profile(path):
    path = Path(path).resolve()
    value = json.loads(path.read_text())
    allowed = {'name', 'root', 'state', 'envs', 'models', 'breeze_source', 'gpus', 'ports', 'llm', 'timeout', 'model_repos', 'model_revisions'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError('unknown machine profile fields')
    def local(p):
        p = Path(p).expanduser()
        return str((path.parent / p).resolve())
    root = local(value.get('root', './local-serving'))
    result = {'name': value.get('name', 'Local 4090 voice'), 'root': root,
              'state': local(value.get('state', root + '/state')),
              'breeze_source': local(value.get('breeze_source', root + '/breeze-src')),
              'timeout': value.get('timeout', 600)}
    for key, defaults in [('envs', {s: root + '/env-' + s for s in ('llm', 'asr', 'tts')}),
                          ('models', {'llm': root + '/models/llm', 'asr': root + '/models/whisper', 'tts': root + '/models/breeze'}),
                          ('model_repos', {'llm': 'Qwen/Qwen3.5-4B', 'asr': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', 'tts': 'BreezeBlue/Breeze-TTS-2'}),
                          ('model_revisions', {'llm': 'main', 'asr': '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf', 'tts': 'main'}),
                          ('gpus', {'llm': 0, 'asr': 1, 'tts': 0}),
                          ('ports', {'llm': 18101, 'asr': 18102, 'tts': 18103}),
                          ('llm', {'model': 'Qwen/Qwen3.5-4B', 'memory': .5, 'context': 8192, 'max_sequences': 1})]:
        overrides = value.get(key, {})
        if not isinstance(overrides, dict) or set(overrides) - defaults.keys():
            raise ValueError('unknown ' + key + ' fields')
        result[key] = {**defaults, **overrides}
    for key in ('envs', 'models'):
        result[key] = {k: local(v) for k, v in result[key].items()}
    if any(type(p) is not int or not 1 <= p <= 65535 for p in result['ports'].values()) or len(set(result['ports'].values())) != 3:
        raise ValueError('ports must be three distinct integers from 1 to 65535')
    if any(type(g) is not int or g < 0 for g in result['gpus'].values()):
        raise ValueError('GPU indices must be nonnegative integers')
    if any(not isinstance(v, str) or not v.strip() for key in ('model_repos', 'model_revisions') for v in result[key].values()):
        raise ValueError('model repositories and revisions must be nonempty strings')
    llm = result['llm']
    if not isinstance(llm['model'], str) or not llm['model'].strip() or not isinstance(result['name'], str) or not result['name'].strip():
        raise ValueError('name and LLM model must be nonempty strings')
    if type(llm['memory']) not in (int, float) or not 0 < llm['memory'] < 1:
        raise ValueError('LLM memory fraction must be between 0 and 1')
    if any(type(llm[k]) is not int or llm[k] < 1 for k in ('context', 'max_sequences')):
        raise ValueError('LLM context and max_sequences must be positive integers')
    if type(result['timeout']) not in (int, float) or not 0 < result['timeout'] <= 3600:
        raise ValueError('readiness timeout must be 1..3600 seconds')
    return result


def preset(config):
    ports = config['ports']
    return {'schema': 'nova.voice-preset', 'version': 1, 'name': config['name'],
            'asr': {'provider': 'self-hosted', 'url': f"ws://127.0.0.1:{ports['asr']}/v1/audio/stream"},
            'llm': {'provider': 'self-hosted', 'baseUrl': f"http://127.0.0.1:{ports['llm']}/v1", 'model': config['llm']['model']},
            'tts': {'provider': 'self-hosted', 'url': f"http://127.0.0.1:{ports['tts']}/v1/audio/speech"}}


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]  # starttime; PID reuse is not ownership.
    except FileNotFoundError:
        return None


def owned(record):
    return identity(record['pid']) == record['start'] and record['start'] is not None


def terminate(record):
    if not owned(record):
        return
    try:
        if os.getpgid(record['pid']) != record['pid']:
            raise RuntimeError('refusing to signal a process outside its owned session')
        os.killpg(record['pid'], signal.SIGTERM)
        until = time.monotonic() + 10
        while owned(record) and time.monotonic() < until:
            time.sleep(.05)
        if owned(record):
            os.killpg(record['pid'], signal.SIGKILL)
    except ProcessLookupError:
        pass


def worker(command):
    # The session leader stays alive while its model runs. On exit it cleans its
    # own group, including grandchildren, even if the model crashed first.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: None)
    try:
        subprocess.Popen(command).wait()
    finally:
        os.killpg(os.getpgrp(), signal.SIGTERM)
        time.sleep(.2)
        os.killpg(os.getpgrp(), signal.SIGKILL)


def launch(name, command, environment, state):
    with (state / (name + '.log')).open('ab') as log:
        child = subprocess.Popen([sys.executable, str(HERE / 'serve.py'), '_worker', *command],
                                 env={**os.environ, **environment}, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    record = {'pid': child.pid, 'start': identity(child.pid), 'name': name}
    return child, record


def healthy(url):
    try:
        # Loopback probes must never use an inherited HTTP proxy.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def wait_ready(child, record, url, timeout):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if child.poll() is not None or not owned(record):
            raise RuntimeError(record['name'] + ' exited; see its state-directory log')
        if healthy(url):
            return
        time.sleep(.2)
    raise RuntimeError(record['name'] + ' readiness timed out; see its state-directory log')


def gpu_environment(index, python):
    rows = subprocess.check_output(['nvidia-smi', '--query-gpu=index,pci.bus_id,uuid', '--format=csv,noheader'], text=True)
    devices = [tuple(x.strip() for x in row.split(',')) for row in rows.splitlines()]
    selected = next((d for d in devices if d[0] == str(index)), None)
    if selected is None:
        raise ValueError('selected GPU does not exist')
    # vLLM 0.17 requires a numeric visible ordinal. Match physical PCI order and
    # verify the CUDA UUID before model loading instead of trusting nvidia indices.
    ordinal = sorted(devices, key=lambda d: d[1]).index(selected)
    env = {'CUDA_DEVICE_ORDER': 'PCI_BUS_ID', 'CUDA_VISIBLE_DEVICES': str(ordinal)}
    subprocess.run([python, '-c', 'import sys,torch; actual=str(torch.cuda.get_device_properties(0).uuid); assert actual.removeprefix("GPU-").lower()==sys.argv[1].removeprefix("GPU-").lower(), "CUDA physical GPU mismatch"', selected[2]], env={**os.environ, **env}, check=True)
    return env


def commands(config):
    python = {s: str(Path(p) / 'bin/python') for s, p in config['envs'].items()}
    for p in [*python.values(), *config['models'].values(), config['breeze_source']]:
        if not Path(p).exists():
            raise ValueError('missing serving dependency/model path: ' + p)
    ports, models, llm = config['ports'], config['models'], config['llm']
    result = {
        'llm': [python['llm'], '-m', 'vllm.entrypoints.openai.api_server', '--model', models['llm'], '--served-model-name', llm['model'],
                '--host', '127.0.0.1', '--port', str(ports['llm']), '--max-model-len', str(llm['context']),
                '--max-num-seqs', str(llm['max_sequences']), '--gpu-memory-utilization', str(llm['memory']),
                '--cudagraph-capture-sizes', '1', '--language-model-only', '--enable-auto-tool-choice',
                '--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'qwen3',
                '--default-chat-template-kwargs', '{"enable_thinking":false}'],
        'asr': [python['asr'], '-m', 'uvicorn', 'whisper_server:app', '--app-dir', str(HERE), '--host', '127.0.0.1', '--port', str(ports['asr'])],
        'tts': [python['tts'], '-m', 'breeze_infer.api', models['tts'], '--host', '127.0.0.1', '--port', str(ports['tts']), '--fast-backbone-decode', '--fast-depth-decoder'],
    }
    # CTranslate2 resolves cuBLAS/cuDNN before Python can amend its search path.
    cuda_libraries = sorted(Path(config['envs']['asr']).glob('lib/python*/site-packages/nvidia/*/lib'))
    library_path = ':'.join([*(str(path) for path in cuda_libraries), *filter(None, [os.environ.get('LD_LIBRARY_PATH')])])
    return [(s, result[s], {**gpu_environment(config['gpus'][s], python['llm']), 'HF_HUB_OFFLINE': '1',
                           **({'LD_LIBRARY_PATH': library_path} if s == 'asr' and library_path else {}),
                           'WHISPER_MODEL_PATH': models['asr'], 'PYTHONPATH': config['breeze_source']}) for s in ('llm', 'asr', 'tts')]


def write_records(path, records):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(records))
    temporary.replace(path)


def start(config, state, records_path, records):
    configuration = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    if any(owned(r) for r in records):
        if len(records) == 3 and {r['name'] for r in records} == {'llm', 'asr', 'tts'} and all(
                owned(r) and r.get('configuration') == configuration and healthy(f"http://127.0.0.1:{config['ports'][r['name']]}/health") for r in records):
            print('All owned workers already ready')
            return
        raise RuntimeError('owned workers differ or are unhealthy; use status or stop first')
    # Reject foreign listeners before starting any worker; never stop them.
    for port in config['ports'].values():
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    launches = commands(config)
    active, children = [], []
    try:
        for name, command, env in launches:
            child, record = launch(name, command, env, state)
            children.append(child)
            record['configuration'] = configuration
            active.append(record)
            write_records(records_path, active)
            wait_ready(child, record, f"http://127.0.0.1:{config['ports'][name]}/health", config['timeout'])
            print(name + ' ready', flush=True)
        write_records(state / 'voice-preset.json', preset(config))
    except BaseException:
        for record in reversed(active):
            terminate(record)
        for child in children:
            child.wait()
        write_records(records_path, [])
        raise


def setup(config):
    source = Path(config['breeze_source'])
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', 'https://github.com/breezeblue-ai/breeze-tts.git', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', '--detach', BREEZE_COMMIT], check=True)
        subprocess.run(['git', '-C', str(source), 'apply', str(HERE / 'breeze-cancel.patch')], check=True)
    elif 'ClosingStreamingResponse' not in (source / 'breeze_infer/api.py').read_text():
        raise ValueError('existing Breeze source lacks disconnect fix; apply serving/breeze-cancel.patch explicitly')
    for service in ('llm', 'asr', 'tts'):
        directory = Path(config['envs'][service])
        if (directory / 'SETUP_FAILED').exists():
            raise ValueError('previous setup failed; choose a fresh environment path: ' + str(directory))
        if (directory / 'bin/python').exists():
            print(service + ' environment reused without modification', flush=True)
            continue
        if directory.exists():
            raise ValueError('incomplete environment exists; use a new path: ' + str(directory))
        subprocess.run([sys.executable, '-m', 'venv', str(directory)], check=True)
        try:
            subprocess.run([str(directory / 'bin/python'), '-m', 'pip', 'install', '-r', str(HERE / ('requirements-' + service + '.txt'))], check=True)
        except BaseException:
            # Do not claim a partially installed environment is reusable.
            (directory / 'SETUP_FAILED').touch()
            raise
    python = str(Path(config['envs']['asr']) / 'bin/python')
    for service, model in config['models'].items():
        target = Path(model)
        if target.exists():
            print(service + ' model weights reused without modification', flush=True)
            continue
        if target.is_symlink():
            raise ValueError('model path is a broken symlink: ' + str(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        # A failed/interrupted download never becomes an apparently ready model.
        with tempfile.TemporaryDirectory(prefix=target.name + '.download-', dir=target.parent) as temporary:
            subprocess.run([python, '-c', 'import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3])',
                            config['model_repos'][service], config['model_revisions'][service], temporary], check=True)
            if target.exists() or target.is_symlink():
                raise ValueError('model destination appeared during download; refusing to replace it')
            Path(temporary).rename(target)
    print('Setup complete.')


def main():
    def interrupted(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('command', choices=['setup', 'start', 'stop', 'status', 'export', 'up'])
    args = parser.parse_args()
    config = load_profile(args.profile)
    if args.command == 'export':
        print(json.dumps(preset(config), indent=2))
        return 0
    if sys.platform != 'linux':
        raise ValueError('setup/start/stop/status require Linux; export works on any platform')
    import fcntl
    state = Path(config['state'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        records_path = state / 'workers.json'
        records = json.loads(records_path.read_text()) if records_path.exists() else []
        if args.command == 'status':
            statuses = [{**r, 'running': owned(r), 'healthy': owned(r) and healthy(f"http://127.0.0.1:{config['ports'][r['name']]}/health")} for r in records]
            print(json.dumps(statuses, indent=2))
            return 0 if len(statuses) == 3 and all(r['healthy'] for r in statuses) else 1
        if args.command == 'stop':
            for record in reversed(records):
                terminate(record)
            write_records(records_path, [])
            print('Owned workers stopped')
        if args.command in ('setup', 'up'):
            if any(owned(r) for r in records):
                if args.command == 'up':
                    start(config, state, records_path, records)
                    return 0
                raise RuntimeError('stop owned workers before setup')
            setup(config)
        if args.command in ('start', 'up'):
            start(config, state, records_path, records)
    return 0


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '_worker':
        worker(sys.argv[2:])
    else:
        try:
            raise SystemExit(main())
        except KeyboardInterrupt:
            print('Serving operation interrupted', file=sys.stderr)
            raise SystemExit(130)
        except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
            print(str(error), file=sys.stderr)
            raise SystemExit(1)
