"""No models, network downloads or GPUs: python3 -m unittest discover -s serving."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import socket
import time
from contextlib import ExitStack
from unittest.mock import patch
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('serve', pathlib.Path(__file__).with_name('serve.py'))
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServingTest(unittest.TestCase):
    def test_preset_contains_only_client_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = pathlib.Path(directory) / 'machine.json'
            profile.write_text(json.dumps({'root': './private-model-root'}))
            config = serve.load_profile(profile)
            result = serve.preset(config)
            self.assertEqual(set(result), {'schema', 'version', 'name', 'asr', 'llm', 'tts'})
            self.assertEqual(result['schema'], 'nova.voice-preset')
            self.assertEqual(result['version'], 1)
            self.assertEqual(result['asr']['url'], 'ws://127.0.0.1:18102/v1/audio/stream')
            self.assertNotIn('private-model-root', json.dumps(result))
            profile.write_text(json.dumps({'root': directory, 'ports': {'llm': 18102}}))
            with self.assertRaises(ValueError):
                serve.load_profile(profile)

    def test_start_is_idempotent_only_for_same_healthy_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'machine.json'
            path.write_text(json.dumps({'root': directory}))
            config = serve.load_profile(path)
            fingerprint = serve.hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
            records = [{'name': name, 'configuration': fingerprint} for name in ('llm', 'asr', 'tts')]
            with patch.object(serve, 'owned', return_value=True), patch.object(serve, 'healthy', return_value=True), patch.object(serve, 'commands') as commands:
                serve.start(config, root, root / 'workers.json', records)
                commands.assert_not_called()
                config['llm']['memory'] = .6
                with self.assertRaisesRegex(RuntimeError, 'differ'):
                    serve.start(config, root, root / 'workers.json', records)

    def test_setup_never_mutates_reused_environments_or_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'machine.json'
            path.write_text(json.dumps({'root': directory}))
            config = serve.load_profile(path)
            source = pathlib.Path(config['breeze_source']) / 'breeze_infer'
            source.mkdir(parents=True)
            (source / 'api.py').write_text('class ClosingStreamingResponse: pass')
            for directory in config['envs'].values():
                binary = pathlib.Path(directory) / 'bin/python'
                binary.parent.mkdir(parents=True)
                binary.write_text('existing environment')
            for directory in config['models'].values():
                pathlib.Path(directory).mkdir(parents=True)
            with patch.object(serve.subprocess, 'run') as run:
                serve.setup(config)
                run.assert_not_called()
                failed = pathlib.Path(config['envs']['llm']) / 'SETUP_FAILED'
                failed.touch()
                with self.assertRaisesRegex(ValueError, 'previous setup failed'):
                    serve.setup(config)
                run.assert_not_called()

    def test_gpu_probes_use_llm_python_and_asr_gets_cuda_libraries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'machine.json'
            path.write_text(json.dumps({'root': directory}))
            config = serve.load_profile(path)
            for environment in config['envs'].values():
                binary = pathlib.Path(environment) / 'bin/python'
                binary.parent.mkdir(parents=True)
                binary.touch()
            for model in config['models'].values():
                pathlib.Path(model).mkdir(parents=True)
            pathlib.Path(config['breeze_source']).mkdir()
            cuda = pathlib.Path(config['envs']['asr']) / 'lib/python3.12/site-packages/nvidia'
            libraries = [cuda / component / 'lib' for component in ('cublas', 'cudnn')]
            for library in libraries:
                library.mkdir(parents=True)
            with patch.object(serve, 'gpu_environment', return_value={}) as probe, patch.dict(serve.os.environ, {'LD_LIBRARY_PATH': '/existing/cuda/lib'}):
                commands = serve.commands(config)
            self.assertTrue(all(call.args[1] == str(pathlib.Path(config['envs']['llm']) / 'bin/python') for call in probe.call_args_list))
            asr = next(environment for name, _, environment in commands if name == 'asr')
            self.assertEqual(asr['LD_LIBRARY_PATH'].split(':'), [*(str(path) for path in libraries), '/existing/cuda/lib'])

    @unittest.skipUnless(sys.platform == 'linux', 'Linux /proc owns process identities')
    def test_owned_lifecycle_and_stale_pid_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            child, record = serve.launch('fake', [sys.executable, '-c', 'import time; time.sleep(60)'], {}, root)
            try:
                self.assertTrue(serve.owned(record))
                stale = {**record, 'start': str(int(record['start']) + 1)}
                self.assertFalse(serve.owned(stale))
                serve.terminate(stale)
                self.assertIsNone(child.poll(), 'must never signal a reused PID')
                serve.terminate(record)
                child.wait(timeout=5)
                self.assertFalse(serve.owned(record))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    @unittest.skipUnless(sys.platform == 'linux', 'Linux /proc owns process identities')
    def test_readiness_failure_stops_launched_children(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            child, record = serve.launch('failed', [sys.executable, '-c', 'raise SystemExit(3)'], {}, root)
            try:
                with self.assertRaises(RuntimeError):
                    serve.wait_ready(child, record, 'http://127.0.0.1:1/health', .5)
            finally:
                serve.terminate(record)
                child.wait(timeout=5)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux /proc owns process identities')
    def test_start_rolls_back_and_does_not_touch_foreign_listener(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            profile = root / 'machine.json'
            with socket.socket() as foreign:
                foreign.bind(('127.0.0.1', 0))
                foreign.listen()
                port = foreign.getsockname()[1]
                profile.write_text(json.dumps({'root': directory, 'ports': {'llm': port}}))
                config = serve.load_profile(profile)
                with self.assertRaises(OSError), patch.object(serve, 'commands') as commands:
                    serve.start(config, root, root / 'workers.json', [])
                commands.assert_not_called()
                self.assertEqual(foreign.getsockname()[1], port)
            with ExitStack() as stack:
                probes = [stack.enter_context(socket.socket()) for _ in range(3)]
                for probe in probes:
                    probe.bind(('127.0.0.1', 0))
                ports = dict(zip(('llm', 'asr', 'tts'), [probe.getsockname()[1] for probe in probes]))
            profile.write_text(json.dumps({'root': directory, 'ports': ports}))
            config = serve.load_profile(profile)
            launched = []
            original = serve.launch
            def launch(*args):
                child, record = original(*args)
                launched.append((child, record))
                return child, record
            fake = [('llm', [sys.executable, '-c', 'import time; time.sleep(60)'], {})]
            with patch.object(serve, 'commands', return_value=fake), patch.object(serve, 'launch', side_effect=launch), patch.object(serve, 'wait_ready', side_effect=RuntimeError('unready')):
                with self.assertRaisesRegex(RuntimeError, 'unready'):
                    serve.start(config, root, root / 'workers.json', [])
            self.assertEqual(json.loads((root / 'workers.json').read_text()), [])
            self.assertTrue(launched)
            self.assertTrue(all(not serve.owned(record) for _, record in launched))

    @unittest.skipUnless(sys.platform == 'linux', 'Linux /proc owns process identities')
    def test_health_and_descendant_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            command = [sys.executable, '-c',
                       'import subprocess,sys,pathlib,http.server; '
                       'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); '
                       'pathlib.Path(sys.argv[1]).write_text(str(p.pid)); '
                       'http.server.HTTPServer(("127.0.0.1",int(sys.argv[2])),http.server.SimpleHTTPRequestHandler).serve_forever()',
                       str(root / 'descendant'), str(port)]
            child, record = serve.launch('ready', command, {}, root)
            try:
                serve.wait_ready(child, record, f'http://127.0.0.1:{port}/', 5)
                descendant = int((root / 'descendant').read_text())
                self.assertIsNotNone(serve.identity(descendant))
                serve.terminate(record)
                child.wait(timeout=5)
                self.assertIsNone(serve.identity(descendant))
                self.assertFalse(serve.healthy(f'http://127.0.0.1:{port}/'))
            finally:
                serve.terminate(record)
                child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
