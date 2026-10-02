#!/usr/bin/env python3
"""One-task, supervised adapter for the pinned official PhoneAgent (not a runtime)."""
import ast
import base64
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

UPSTREAM_COMMIT = "86f55382982fb054e8fc98ca80609dff8a2cdc3c"
LINE_LIMIT = 65536
TOTAL_LIMIT = 1048576
WRITES = {"Launch", "Tap", "Type", "Type_Name", "Swipe", "Back", "Home", "Double Tap", "Long Press"}


class Stop(BaseException):
    # Upstream catches Exception and converts some failures to successful finish.
    def __init__(self, code):
        self.code = code


def require(ok, code="protocol_error"):
    if not ok:
        raise Stop(code)


def string(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and "\0" not in value


class Protocol:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.in_bytes = self.out_bytes = 0
        self.task_id = "invalid"

    def read(self):
        line = self.reader.readline(LINE_LIMIT + 1)
        self.in_bytes += len(line)
        require(line.endswith(b"\n") and len(line) <= LINE_LIMIT and self.in_bytes <= TOTAL_LIMIT)
        try:
            value = json.loads(line.decode("utf-8"), object_pairs_hook=self.unique)
        except (ValueError, UnicodeError, RecursionError):
            raise Stop("protocol_error")
        require(type(value) is dict and type(value.get("version")) is int and value["version"] == 1)
        return value

    @staticmethod
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result

    def emit(self, kind, **fields):
        line = (json.dumps(dict(version=1, taskId=self.task_id, type=kind, **fields), ensure_ascii=True, allow_nan=False) + "\n").encode()
        self.out_bytes += len(line)
        require(len(line) <= LINE_LIMIT and self.out_bytes <= TOTAL_LIMIT)
        self.writer.write(line)
        self.writer.flush()


def validate_start(start):
    require(set(start) == {"version", "type", "taskId", "instruction", "deviceId", "deviceType", "maxSteps", "budgetMs", "baseUrl", "model"} | ({"wdaUrl"} if start.get("deviceType") in {"ios", "ios-simulator"} else set()))
    require(start["deviceType"] in {"ios", "ios-simulator", "android"}, "invalid_configuration")
    if start["deviceType"] in {"ios", "ios-simulator"}:
        require(string(start["wdaUrl"], 2048), "invalid_configuration")
        validate_url(start["wdaUrl"])
        if start["deviceType"] == "ios-simulator":
            url = urlsplit(start["wdaUrl"])
            require(url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"} and url.path in {"", "/"}, "invalid_configuration")
    require(start["type"] == "start" and string(start["taskId"], 200) and string(start["instruction"], 16000))
    require(string(start["deviceId"], 200) and re.fullmatch(r"[A-Za-z0-9_.:\-]+", start["deviceId"]), "invalid_configuration")
    require(type(start["maxSteps"]) is int and 1 <= start["maxSteps"] <= 100, "invalid_configuration")
    require(type(start["budgetMs"]) is int and 1 <= start["budgetMs"] <= 3600000, "invalid_configuration")
    require(string(start["baseUrl"], 2048) and string(start["model"], 200), "invalid_configuration")
    validate_url(start["baseUrl"])


def validate_url(value):
    url = urlsplit(value)
    require(url.hostname and not url.username and not url.password and not url.fragment and not url.query and (url.scheme == "https" or (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"})), "invalid_configuration")


def verify_source(source):
    source = Path(source).resolve(strict=True)
    def git(*args):
        return subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True, timeout=10).stdout
    require(git("rev-parse", "HEAD").decode().strip() == UPSTREAM_COMMIT, "invalid_configuration")
    # Compare actual imported source bytes to the pinned Git tree, including ignored files.
    tracked = {}
    for entry in git("ls-tree", "-rz", UPSTREAM_COMMIT, "phone_agent").split(b"\0"):
        if entry:
            meta, name = entry.split(b"\t", 1)
            tracked[name.decode()] = meta.split()[2].decode()
    require(tracked, "invalid_configuration")
    for name, digest in tracked.items():
        path = source / name
        require(not path.is_symlink(), "invalid_configuration")
        data = path.read_bytes()
        require(hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == digest, "invalid_configuration")
    for path in (source / "phone_agent").rglob("*"):
        if path.is_file() and "__pycache__" not in path.parts:
            require(str(path.relative_to(source)) in tracked, "invalid_configuration")
    return source


def validate_action(action):
    require(type(action) is dict, "model_failed")
    if action.get("_metadata") == "finish":
        require(set(action) <= {"_metadata", "message"} and isinstance(action.get("message", ""), str), "model_failed")
        return "finish"
    require(action.get("_metadata") == "do", "model_failed")
    name = action.get("action")
    require(name in WRITES | {"Wait", "Take_over", "Interact", "Note", "Call_API"}, "action_failed")
    fields = {"_metadata", "action", "message"}
    if name == "Launch":
        fields.add("app")
        require(string(action.get("app"), 200), "model_failed")
    elif name in {"Type", "Type_Name"}:
        fields.add("text")
        require(isinstance(action.get("text"), str) and len(action["text"]) <= 4000 and "\0" not in action["text"], "model_failed")
    elif name in {"Tap", "Double Tap", "Long Press", "Swipe"}:
        for key in (["start", "end"] if name == "Swipe" else ["element"]):
            fields.add(key)
            point = action.get(key)
            require(type(point) is list and len(point) == 2 and all(type(n) is int and 0 <= n <= 1000 for n in point), "model_failed")
    elif name == "Wait":
        fields.add("duration")
        require(isinstance(action.get("duration", "1 seconds"), str) and re.fullmatch(r"(?:[0-4](?:\.\d{1,2})?|5(?:\.0{1,2})?) seconds", action.get("duration", "1 seconds")), "model_failed")
    require(set(action) <= fields and ("message" not in action or string(action["message"], 1000)), "model_failed")
    return name


class Bridge:
    def __init__(self, protocol, start):
        self.protocol, self.start = protocol, start
        self.deadline = time.monotonic() + start["budgetMs"] / 1000
        self.step = 0
        self.last_action = None
        self.screen = None
        self.package = None
        self.approved = False
        self.tunnel = None

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "timeout")
        return remaining

    def gate(self, execute, capture, package, action, width, height):
        self.remaining()
        name = validate_action(action)
        if name in {"Take_over", "Interact"}:
            raise Stop("needs_user_action")
        if name in {"Note", "Call_API"}:
            raise Stop("action_failed")
        if name in WRITES:
            require(self.screen is not None and self.package is not None, "action_failed")
            request_id = uuid.uuid4().hex
            self.protocol.emit("approval", requestId=request_id, step=self.step, action=action, screenDigest=self.screen, packageName=self.package)
            decision = self.protocol.read()
            require(set(decision) == {"version", "type", "taskId", "requestId", "decision"} and decision["type"] == "decision" and decision["taskId"] == self.start["taskId"] and decision["requestId"] == request_id and decision["decision"] in {"accept", "decline"})
            require(decision["decision"] == "accept", "declined")
            self.remaining()
            require(package() == self.package and capture()[1] == self.screen, "screen_changed")
            self.remaining()
            self.protocol.emit("progress", step=self.step, phase="action", **self.last_fields())
        try:
            self.approved = name in WRITES
            result = execute(action, width, height)
        except Exception:
            raise Stop("action_failed")
        finally:
            self.approved = False
        require(result.success, "action_failed")
        self.remaining()
        if name in WRITES:
            self.last_action = name
            self.protocol.emit("progress", step=self.step, phase="action_returned", **self.last_fields())
        return result

    def last_fields(self):
        return {"lastAction": self.last_action} if self.last_action else {}

    def android(self, api_key):
        import phone_agent.agent as upstream
        from phone_agent.model import ModelConfig
        from phone_agent.adb.screenshot import Screenshot
        from PIL import Image

        original_run = subprocess.run
        serial = self.start["deviceId"]
        devices = original_run(["adb", "devices"], capture_output=True, text=True, check=True, timeout=min(10, self.remaining())).stdout
        require([line.split()[1] for line in devices.splitlines() if len(line.split()) >= 2 and line.split()[0] == serial] == ["device"], "invalid_configuration")

        def checked_run(args, **kwargs):
            require(isinstance(args, list) and args[:3] == ["adb", "-s", serial], "action_failed")
            kwargs["check"] = True
            kwargs["timeout"] = min(kwargs.get("timeout", 10), self.remaining())
            try:
                return original_run(args, **kwargs)
            except subprocess.TimeoutExpired:
                raise Stop("timeout")
            except Exception:
                raise Stop("action_failed")

        def package():
            output = checked_run(["adb", "-s", serial, "shell", "dumpsys", "window"], capture_output=True, text=True).stdout
            focused = [line for line in output.splitlines() if "mCurrentFocus=" in line]
            match = re.search(r"\b([A-Za-z][A-Za-z0-9_.]*)/[A-Za-z0-9_.$]+", " ".join(focused))
            require(match is not None, "action_failed")
            return match.group(1)

        def capture():
            data = checked_run(["adb", "-s", serial, "exec-out", "screencap", "-p"], capture_output=True).stdout
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                digest = hashlib.sha256(str(image.size).encode() + image.convert("RGB").tobytes()).hexdigest()
                shot = Screenshot(base64.b64encode(data).decode(), image.width, image.height)
            return shot, digest

        factory = upstream.get_device_factory()
        def screenshot(device_id):
            require(device_id == serial, "action_failed")
            shot, self.screen = capture()
            self.package = package()
            return shot
        factory.get_screenshot = screenshot
        agent = upstream.PhoneAgent(ModelConfig(base_url=self.start["baseUrl"], api_key=api_key, model_name=self.start["model"]), upstream.AgentConfig(max_steps=self.start["maxSteps"], device_id=serial, verbose=False), confirmation_callback=lambda _: True, takeover_callback=lambda _: (_ for _ in ()).throw(Stop("needs_user_action")))
        subprocess.run = checked_run
        return upstream, agent, capture, package

    def run(self, source, api_key):
        sys.dont_write_bytecode = True
        with tempfile.TemporaryDirectory(prefix="nova-autoglm-bytecode-") as cache:
            sys.pycache_prefix = cache
            # Import only the verified package, never expose checkout-root modules.
            spec = importlib.util.spec_from_file_location("phone_agent", Path(source) / "phone_agent" / "__init__.py", submodule_search_locations=[str(Path(source) / "phone_agent")])
            package = importlib.util.module_from_spec(spec)
            sys.modules["phone_agent"] = package
            try:
                spec.loader.exec_module(package)
                return self.run_agent(api_key)
            finally:
                if self.tunnel is not None:
                    self.tunnel.terminate()
                    try:
                        self.tunnel.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self.tunnel.kill()
                        self.tunnel.wait(timeout=2)

    def wda_endpoint(self):
        configured = urlsplit(self.start["wdaUrl"])
        if self.start["deviceType"] == "ios-simulator":
            return self.start["wdaUrl"].rstrip("/"), False
        local = configured.hostname in {"localhost", "127.0.0.1", "::1"}
        if not local:
            return self.start["wdaUrl"].rstrip("/"), False
        require(configured.scheme == "http" and configured.path in {"", "/"}, "invalid_configuration")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.tunnel = subprocess.Popen(["iproxy", "-u", self.start["deviceId"], "-l", "-s", "127.0.0.1", f"{port}:{configured.port or 8100}"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + min(5, self.remaining())
        while time.monotonic() < deadline:
            require(self.tunnel.poll() is None, "invalid_configuration")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    require(self.tunnel.poll() is None, "invalid_configuration")
                    return f"http://127.0.0.1:{port}", True
            except OSError:
                time.sleep(0.05)
        raise Stop("invalid_configuration")

    def simulator_identity(self):
        port = urlsplit(self.start["wdaUrl"]).port or 80
        def output(args):
            return subprocess.run(args, capture_output=True, text=True, check=True, timeout=min(5, self.remaining())).stdout.strip()
        listeners = output(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"])
        pids = {line[1:] for line in listeners.splitlines() if re.fullmatch(r"p[0-9]+", line)}
        require(len(pids) == 1, "invalid_configuration")
        pid = next(iter(pids))
        executable = output(["/bin/ps", "-p", pid, "-o", "comm="])
        require(Path(executable).name in {"WebDriverAgentRunner-Runner", "WebDriverAgentRunner"}, "invalid_configuration")
        environment = output(["/bin/ps", "eww", "-p", pid, "-o", "command="])
        ids = re.findall(r"(?:^|\s)SIMULATOR_UDID=([^\s]+)(?=\s|$)", environment)
        require(ids == [self.start["deviceId"]], "invalid_configuration")
        return pid, output(["/bin/ps", "-p", pid, "-o", "lstart="])

    def ios(self, api_key):
        import phone_agent.agent_ios as upstream
        import phone_agent.xctest.device as ios_device
        from phone_agent.actions.handler_ios import ActionResult
        from phone_agent.model import ModelConfig
        from phone_agent.xctest.screenshot import Screenshot
        from PIL import Image
        import requests

        serial = self.start["deviceId"]
        simulator = self.start["deviceType"] == "ios-simulator"
        if simulator:
            listing = subprocess.run(["xcrun", "simctl", "list", "devices", "booted", "-j"], capture_output=True, text=True, check=True, timeout=min(10, self.remaining())).stdout
            devices = [device.get("udid") for group in json.loads(listing)["devices"].values() for device in group if device.get("state") == "Booted" and device.get("isAvailable", True)]
        else:
            devices = subprocess.run(["idevice_id", "-l"], capture_output=True, text=True, check=True, timeout=min(10, self.remaining())).stdout.splitlines()
        require(devices.count(serial) == 1, "invalid_configuration")
        base, owned_tunnel = self.wda_endpoint()
        simulator_process = self.simulator_identity() if simulator else None
        original_request = requests.sessions.Session.request
        def checked_request(session, method, url, **kwargs):
            if simulator:
                require(self.simulator_identity() == simulator_process, "invalid_configuration")
            require(url.startswith(base + "/") and method.upper() in {"GET", "POST"}, "action_failed")
            require(method.upper() == "GET" or self.approved, "action_failed")
            session.trust_env = False
            kwargs.update(verify=True, allow_redirects=False, timeout=min(10, self.remaining()))
            try:
                response = original_request(session, method, url, **kwargs)
                require(response.status_code in {200, 201}, "action_failed")
                data = response.json()
                require(type(data) is dict and not (isinstance(data.get("value"), dict) and data["value"].get("error")), "action_failed")
                if url.endswith("/element/active"):
                    value = data.get("value")
                    element = (value.get("ELEMENT") or value.get("element-6066-11e4-a52e-4f735466cecf")) if isinstance(value, dict) else None
                    require(string(element, 200) and re.fullmatch(r"[A-Za-z0-9_-]+", element), "needs_user_action")
                return response
            except Exception:
                raise Stop("action_failed")
        requests.sessions.Session.request = checked_request
        status = requests.get(base + "/status").json()
        value = status.get("value") or {}
        device_info = value.get("device")
        reported_id = value.get("udid") or (device_info.get("udid") if isinstance(device_info, dict) else None)
        require(reported_id == serial or ((owned_tunnel or simulator_process) and not reported_id), "invalid_configuration")
        session_id = status.get("sessionId") or (status.get("value") or {}).get("sessionId")
        require(string(session_id, 200) and re.fullmatch(r"[A-Za-z0-9_-]+", session_id), "invalid_configuration")
        def package():
            info = requests.get(base + "/wda/activeAppInfo").json().get("value", {})
            bundle = info.get("bundleId")
            require(string(bundle, 300), "action_failed")
            return bundle
        def capture():
            encoded = requests.get(base + "/screenshot").json().get("value")
            require(string(encoded, 30000000), "action_failed")
            data = base64.b64decode(encoded, validate=True)
            size = requests.get(base + f"/session/{session_id}/window/size").json().get("value", {})
            require(all(type(size.get(k)) in {int, float} and 0 < size[k] < 10000 for k in ("width", "height")), "action_failed")
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                digest = hashlib.sha256(str((image.size, size)).encode() + image.convert("RGB").tobytes()).hexdigest()
            # WDA coordinates are logical points, not screenshot pixels.
            return Screenshot(encoded, size["width"], size["height"]), digest
        def screenshot(**kwargs):
            require(kwargs.get("device_id") == serial, "action_failed")
            shot, self.screen = capture()
            self.package = package()
            return shot
        upstream.get_screenshot = screenshot
        upstream.get_current_app = lambda **_: package()
        agent = upstream.IOSPhoneAgent(ModelConfig(base_url=self.start["baseUrl"], api_key=api_key, model_name=self.start["model"]), upstream.IOSAgentConfig(max_steps=self.start["maxSteps"], device_id=serial, wda_url=base, session_id=session_id, verbose=False), confirmation_callback=lambda _: True)
        # Upstream assumes every iPhone is 3x; use WDA logical dimensions instead.
        ios_device.SCALE_FACTOR = 1
        def back(_action, width, height):
            ios_device.swipe(0, height // 2, width // 2, height // 2, wda_url=base, session_id=session_id)
            return ActionResult(True, False)
        agent.action_handler._handle_back = back
        return upstream, agent, capture, package

    def run_agent(self, api_key):
        upstream, agent, capture, package = self.android(api_key) if self.start["deviceType"] == "android" else self.ios(api_key)
        execute = agent.action_handler.execute
        agent.action_handler.execute = lambda action, w, h: self.gate(execute, capture, package, action, w, h)
        parse = upstream.parse_action
        def strict_parse(response):
            try:
                tree = ast.parse(response.strip(), mode="eval").body
                require(isinstance(tree, ast.Call) and isinstance(tree.func, ast.Name) and tree.func.id in {"do", "finish"} and not tree.args, "model_failed")
                keys = [item.arg for item in tree.keywords]
                require(None not in keys and "_metadata" not in keys and len(set(keys)) == len(keys), "model_failed")
                for item in tree.keywords:
                    ast.literal_eval(item.value)
                action = parse(response)
                validate_action(action)
                return action
            except Exception:
                raise Stop("model_failed")
        upstream.parse_action = strict_parse
        request = agent.model_client.request
        def model_request(messages):
            self.protocol.emit("progress", step=self.step, phase="model", **self.last_fields())
            agent.model_client.client = agent.model_client.client.with_options(timeout=min(60, self.remaining()), max_retries=0)
            signal.setitimer(signal.ITIMER_REAL, min(60, self.remaining()))
            try:
                return request(messages)
            except Exception:
                raise Stop("model_failed")
            finally:
                signal.setitimer(signal.ITIMER_REAL, self.remaining())
        agent.model_client.request = model_request
        self.protocol.emit("ready", upstreamCommit=UPSTREAM_COMMIT)
        for self.step in range(1, self.start["maxSteps"] + 1):
            self.remaining()
            result = agent.step(self.start["instruction"] if self.step == 1 else None)
            require(result.success, "model_failed")
            if result.finished:
                require(result.action and result.action.get("_metadata") == "finish", "action_failed")
                return "model_finished"
        return "step_limit"


def main():
    # Preserve protocol output BEFORE any upstream import; discard all other output.
    writer = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    protocol = Protocol(sys.stdin.buffer, writer)
    bridge = None
    code = "invalid_configuration"
    def timeout(_signum, _frame):
        raise Stop("timeout")
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, 10)
    try:
        start = protocol.read()
        if string(start.get("taskId"), 200):
            protocol.task_id = start["taskId"]
        validate_start(start)
        bridge = Bridge(protocol, start)
        signal.setitimer(signal.ITIMER_REAL, bridge.remaining())
        require(string(os.environ.get("AUTOGLM_API_KEY"), 8192), "invalid_configuration")
        source = verify_source(os.environ.get("AUTOGLM_SOURCE_PATH", ""))
        code = bridge.run(source, os.environ["AUTOGLM_API_KEY"])
    except Stop as stop:
        code = stop.code
    except Exception:
        code = "action_failed" if bridge and bridge.step else "invalid_configuration"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    protocol.emit("terminal", code=code, steps=bridge.step if bridge else 0, **(bridge.last_fields() if bridge else {}))


if __name__ == "__main__":
    main()
