"""Phone-free checks; optional AUTOGLM_TEST_SOURCE exercises the real pinned agent."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("autoglm-bridge.py")
spec = importlib.util.spec_from_file_location("autoglm_bridge", SCRIPT)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def start(**changes):
    return dict(version=1, type="start", taskId="task", instruction="Open settings", deviceId="serial", deviceType="android", maxSteps=2, budgetMs=10000, baseUrl="http://localhost:8000/v1", model="autoglm", **changes)


class BridgeTests(unittest.TestCase):
    def test_protocol_limits_and_duplicates(self):
        for data in [b'{"version":1,"version":1}\n', b'[]\n', b'{}', b'x' * 65537, b'{"version":true}\n']:
            with self.subTest(data=data[:40]), self.assertRaises(b.Stop):
                b.Protocol(io.BytesIO(data), io.BytesIO()).read()

    def test_start_validation(self):
        b.validate_start(start())
        for changes in [{"deviceId": ""}, {"deviceId": "-s phone space"}, {"maxSteps": True}, {"baseUrl": "http://remote.test/v1"}, {"budgetMs": 0}]:
            data = start()
            data.update(changes)
            with self.subTest(changes=changes), self.assertRaises(b.Stop):
                b.validate_start(data)

    def test_simulator_requires_loopback_and_process_udid(self):
        config = start()
        config.update(deviceType="ios-simulator", wdaUrl="http://127.0.0.1:8100")
        b.validate_start(config)
        bridge = b.Bridge(b.Protocol(io.BytesIO(), io.BytesIO()), config)
        self.assertEqual(bridge.wda_endpoint(), (config["wdaUrl"], False))
        for url in ["https://wda.example.test", "http://127.0.0.1:8100/other"]:
            with self.assertRaises(b.Stop):
                b.validate_start({**config, "wdaUrl": url})
        for actual_udid, allowed in [("serial", True), ("other", False), ("", False)]:
            def run(args, **kwargs):
                value = "p123\n" if args[0].endswith("lsof") else "/Applications/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner" if args[-1] == "comm=" else f"runner SIMULATOR_UDID={actual_udid} OTHER=value" if args[-1] == "command=" else "Fri Sep 18 12:00:00 2026"
                return SimpleNamespace(stdout=value)
            with self.subTest(actual_udid=actual_udid), patch.object(b.subprocess, "run", run):
                if allowed:
                    self.assertEqual(bridge.simulator_identity()[0], "123")
                else:
                    with self.assertRaises(b.Stop):
                        bridge.simulator_identity()

    def gate(self, action, decision="accept", changed=False, expired=False, wrong_task=False, wrong_request=False):
        p = b.Protocol(io.BytesIO(), io.BytesIO())
        p.task_id = "task"
        bridge = b.Bridge(p, start())
        bridge.screen, bridge.package, bridge.step = "digest", "org.example", 1
        calls = []
        def read():
            event = json.loads(p.writer.getvalue().splitlines()[-1])
            if expired:
                bridge.deadline = time.monotonic() - 1
            return dict(version=1, type="decision", taskId="other" if wrong_task else "task", requestId="other" if wrong_request else event["requestId"], decision=decision)
        p.read = read
        def execute(*args):
            calls.append(args)
            return SimpleNamespace(success=True)
        try:
            bridge.gate(execute, lambda: (None, "changed" if changed else "digest"), lambda: "org.example", action, 100, 200)
            code = "ok"
        except b.Stop as error:
            code = error.code
        return code, calls, p.writer.getvalue()

    def test_every_write_requires_approval(self):
        for name in b.WRITES:
            action = dict(_metadata="do", action=name)
            action.update({"app": "Settings"} if name == "Launch" else {"text": "SECRET"} if name in {"Type", "Type_Name"} else {"start": [1, 1], "end": [2, 2]} if name == "Swipe" else {"element": [1, 2]} if name in {"Tap", "Double Tap", "Long Press"} else {})
            with self.subTest(name=name):
                code, calls, events = self.gate(action)
                self.assertEqual((code, len(calls)), ("ok", 1))
                progress = [json.loads(line) for line in events.splitlines() if json.loads(line)["type"] == "progress"]
                self.assertNotIn("SECRET", json.dumps(progress))
                for kwargs, expected in [({"decision": "decline"}, "declined"), ({"changed": True}, "screen_changed"), ({"expired": True}, "timeout"), ({"decision": "acceptForSession"}, "protocol_error"), ({"wrong_task": True}, "protocol_error"), ({"wrong_request": True}, "protocol_error")]:
                    code, calls, _ = self.gate(action, **kwargs)
                    self.assertEqual((code, calls), (expected, []))

    def test_unsupported_actions(self):
        for name, code in [("Take_over", "needs_user_action"), ("Interact", "needs_user_action"), ("Note", "action_failed"), ("Call_API", "action_failed"), ("Unknown", "action_failed")]:
            result, calls, _ = self.gate(dict(_metadata="do", action=name))
            self.assertEqual((result, calls), (code, []))
        for action in [dict(_metadata="do", action="Tap", element=[True, 1]), dict(_metadata="do", action="Wait", duration="999 seconds")]:
            with self.assertRaises(b.Stop):
                b.validate_action(action)

    def test_wrong_revision(self):
        with patch.object(b.subprocess, "run", return_value=SimpleNamespace(stdout=b"wrong-revision\n")), self.assertRaises(b.Stop) as raised:
            b.verify_source(SCRIPT.parent)
        self.assertEqual(raised.exception.code, "invalid_configuration")

    def test_checkout_root_cannot_shadow_dependencies(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "phone_agent").mkdir()
            (source / "phone_agent" / "__init__.py").write_text("import fractions\n")
            (source / "fractions.py").write_text("raise RuntimeError('ROOT POISON EXECUTED')\n")
            bridge = b.Bridge(b.Protocol(io.BytesIO(), io.BytesIO()), start())
            bridge.run_agent = lambda _: "ok"
            before = list(sys.path)
            with patch.dict(sys.modules):
                sys.modules.pop("fractions", None)
                self.assertEqual(bridge.run(source, "test"), "ok")
                self.assertNotEqual(Path(sys.modules["fractions"].__file__).parent, source)
            self.assertEqual(sys.path, before)

    def test_owned_tunnel_targets_only_configured_udid(self):
        config = start()
        config.update(deviceType="ios", wdaUrl="http://127.0.0.1:8100")
        bridge = b.Bridge(b.Protocol(io.BytesIO(), io.BytesIO()), config)
        with patch.object(b.subprocess, "Popen") as popen, patch.object(b.socket, "socket") as sock, patch.object(b.socket, "create_connection"):
            sock.return_value.__enter__.return_value.getsockname.return_value = ("127.0.0.1", 42001)
            popen.return_value.poll.return_value = None
            self.assertEqual(bridge.wda_endpoint(), ("http://127.0.0.1:42001", True))
            self.assertEqual(popen.call_args.args[0], ["iproxy", "-u", "serial", "-l", "-s", "127.0.0.1", "42001:8100"])

    def test_tunnel_is_reaped_on_failure(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "phone_agent").mkdir()
            (source / "phone_agent" / "__init__.py").write_text("")
            bridge = b.Bridge(b.Protocol(io.BytesIO(), io.BytesIO()), start())
            with patch.object(b.subprocess, "Popen") as popen, patch.dict(sys.modules):
                bridge.tunnel = popen.return_value
                bridge.run_agent = lambda _: (_ for _ in ()).throw(b.Stop("model_failed"))
                with self.assertRaises(b.Stop):
                    bridge.run(source, "test")
                bridge.tunnel.terminate.assert_called_once()
                bridge.tunnel.wait.assert_called_once_with(timeout=2)

    def test_import_output_isolated(self):
        # Emit using both Python and native fd writes where the upstream import runs.
        wrapper = f'''import importlib.util, os
s=importlib.util.spec_from_file_location("bridge", {str(SCRIPT)!r})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.verify_source=lambda _: "/unused"
def run(self, source, key):
 print("SECRET import log", flush=True)
 os.write(1,b"SECRET native log\\n")
 os.write(2,b"SECRET stderr log\\n")
 self.protocol.emit("ready", upstreamCommit=m.UPSTREAM_COMMIT)
 return "model_finished"
m.Bridge.run=run
m.main()
'''
        result = subprocess.run([sys.executable, "-c", wrapper], input=json.dumps(start()).encode() + b"\n", capture_output=True, env={**os.environ, "AUTOGLM_API_KEY": "test"}, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(b"SECRET", result.stdout)
        self.assertEqual([json.loads(line)["type"] for line in result.stdout.splitlines()], ["ready", "terminal"])


@unittest.skipUnless(os.environ.get("AUTOGLM_TEST_SOURCE"), "set AUTOGLM_TEST_SOURCE for pinned upstream integration")
class UpstreamTests(unittest.TestCase):
    def test_remote_wda_requires_matching_reported_udid(self):
        source = b.verify_source(os.environ["AUTOGLM_TEST_SOURCE"])
        sys.path.insert(0, str(source))
        import requests
        for reported in [None, "other-device"]:
            config = start()
            config.update(deviceType="ios", wdaUrl="https://wda.example.test")
            bridge = b.Bridge(b.Protocol(io.BytesIO(), io.BytesIO()), config)
            value = {"sessionId": "test-session", "udid": reported}
            with self.subTest(reported=reported), patch.object(b.subprocess, "run", return_value=SimpleNamespace(stdout="serial\n")), patch.object(requests.sessions.Session, "request", return_value=SimpleNamespace(status_code=200, json=lambda: {"value": value})), self.assertRaises(b.Stop) as raised:
                bridge.ios("test")
            self.assertEqual(raised.exception.code, "invalid_configuration")

    def test_real_ios_agent_and_wda_failures(self):
        source = b.verify_source(os.environ["AUTOGLM_TEST_SOURCE"])
        sys.path.insert(0, str(source))
        import phone_agent.agent_ios as upstream
        import requests
        from PIL import Image
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, format="PNG")
        cases = [("Home", "accept", 200, "step_limit"), ("Home", "decline", 200, "declined"), ("Home", "accept", 500, "action_failed"), ("Tap", "accept", 200, "step_limit"), ("Take_over", "accept", 200, "needs_user_action")]
        cases.extend(("SimulatorHome", decision, 200, "step_limit" if decision == "accept" else "declined") for decision in ["accept", "decline"])
        cases.extend((name, decision, 200, "step_limit" if decision == "accept" else "declined") for name in b.WRITES - {"Home", "Tap"} for decision in ["accept", "decline"])
        for name, decision, http_status, expected in cases:
            config = start()
            config.update(deviceType="ios", wdaUrl="http://127.0.0.1:8100")
            simulator = name == "SimulatorHome"
            if simulator:
                config["deviceType"] = "ios-simulator"
                name = "Home"
            b.validate_start(config)
            p = b.Protocol(io.BytesIO(), io.BytesIO())
            p.task_id = "task"
            bridge = b.Bridge(p, config)
            writes = []
            def read():
                event = json.loads(p.writer.getvalue().splitlines()[-1])
                return dict(version=1, type="decision", taskId="task", requestId=event["requestId"], decision=decision)
            p.read = read
            def http(session, method, url, **kwargs):
                self.assertTrue(kwargs["verify"])
                self.assertFalse(kwargs["allow_redirects"])
                if method.upper() == "POST":
                    writes.append(kwargs.get("json"))
                value = ({"sessionId": "test-session", "device": "iphone"} if simulator else {"sessionId": "test-session", "udid": "serial"}) if url.endswith("/status") else {"bundleId": "org.example"} if url.endswith("/wda/activeAppInfo") else b.base64.b64encode(image.getvalue()).decode() if url.endswith("/screenshot") else {"width": 2, "height": 2} if url.endswith("/window/size") else {"ELEMENT": "field-1"} if url.endswith("/element/active") else None
                return SimpleNamespace(status_code=http_status if method.upper() == "POST" else 200, json=lambda: {"value": value})
            params = ', element=[500, 500]' if name in {"Tap", "Double Tap", "Long Press"} else ', start=[0, 500], end=[500, 500]' if name == "Swipe" else ', text="SECRET"' if name in {"Type", "Type_Name"} else ', app="Safari"' if name == "Launch" else ''
            response = f'do(action="{name}"{params})'
            listing = json.dumps({"devices": {"iOS": [{"udid": "serial", "state": "Booted", "isAvailable": True}]}}) if simulator else "serial\n"
            with self.subTest(name=name, decision=decision, status=http_status, simulator=simulator), patch.object(bridge, "simulator_identity", return_value=("123", "start-time")), patch.object(bridge, "wda_endpoint", return_value=(config["wdaUrl"], not simulator)), patch.object(b.subprocess, "run", return_value=SimpleNamespace(stdout=listing)), patch.object(requests.sessions.Session, "request", http), patch.object(upstream.ModelClient, "request", return_value=SimpleNamespace(action=response, thinking="SECRET")), patch.object(b.signal, "setitimer"), patch.object(upstream, "parse_action", upstream.parse_action), patch.object(upstream, "get_screenshot", upstream.get_screenshot), patch.object(upstream, "get_current_app", upstream.get_current_app), patch("time.sleep"):
                try:
                    actual = bridge.run(source, "test")
                except b.Stop as error:
                    actual = error.code
                self.assertEqual(actual, expected)
                if decision == "decline" or name == "Take_over":
                    self.assertEqual(writes, [])
                if name == "Tap":
                    self.assertIn('"x": 1', json.dumps(writes))

    def test_real_agent_control_points(self):
        source = b.verify_source(os.environ["AUTOGLM_TEST_SOURCE"])
        sys.path.insert(0, str(source))
        import phone_agent.agent as upstream
        from PIL import Image
        image = io.BytesIO()
        Image.new("RGB", (2, 2)).save(image, format="PNG")
        cases = [("finish(message='done')", "device", False, "model_finished"), ("not an action", "device", False, "model_failed"), ("finishjunk", "device", False, "model_failed"), ("do(action='Home')", "device", False, "step_limit"), ("do(action='Take_over')", "device", False, "needs_user_action"), (RuntimeError("SECRET"), "device", False, "model_failed"), ("do(action='Home')", "device", True, "action_failed")]
        cases.extend(("finish(message='done')", state, False, "invalid_configuration") for state in ["offline", "unauthorized", "missing"])
        for response, device_state, action_failure, expected in cases:
            p = b.Protocol(io.BytesIO(), io.BytesIO())
            p.task_id = "task"
            bridge = b.Bridge(p, start())
            def read():
                event = json.loads(p.writer.getvalue().splitlines()[-1])
                return dict(version=1, type="decision", taskId="task", requestId=event["requestId"], decision="accept")
            p.read = read
            def run(args, **kwargs):
                if action_failure and "keyevent" in args:
                    raise subprocess.CalledProcessError(1, args)
                output = f"List of devices attached\nserial\t{device_state}\n" if args == ["adb", "devices"] else "mCurrentFocus=Window{abc u0 org.example/.Main}" if "dumpsys" in args else image.getvalue() if "exec-out" in args else ""
                return SimpleNamespace(stdout=output, stderr="", returncode=0)
            def request(_self, _messages):
                if isinstance(response, Exception):
                    raise response
                return SimpleNamespace(action=response, thinking="SECRET")
            factory = upstream.get_device_factory()
            original_screenshot = factory.get_screenshot
            with self.subTest(response=str(response)), patch.object(b.subprocess, "run", run), patch.object(upstream.ModelClient, "request", request), patch.object(b.signal, "setitimer"), patch.object(upstream, "parse_action", upstream.parse_action), patch("time.sleep"):
                try:
                    actual = bridge.run(source, "test")
                except b.Stop as error:
                    actual = error.code
                finally:
                    factory.get_screenshot = original_screenshot
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
