#!/usr/bin/env python3
"""
server.py — SDK Config Analyzer: Unified Daemon Server
Kết hợp Web Server (port 8080) + Proxy Server (port 8765) trong 1 process duy nhất.

Usage:
    python3 server.py start      # Khởi động daemon (nền)
    python3 server.py stop       # Dừng daemon
    python3 server.py restart    # Restart daemon
    python3 server.py status     # Kiểm tra trạng thái
    python3 server.py run        # Chạy foreground (không daemon, dùng để debug)
"""

import http.server
import socketserver
import subprocess
import json
import threading
import time
import uuid
import os
import sys
import signal
import webbrowser
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── Cấu hình ────────────────────────────────────────────────────────────────

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
WEB_PORT   = 8080   # Web server: serve static files + Google OAuth
PROXY_PORT = 8765   # Proxy server: Bootstrap API + batch jobs
PID_FILE   = os.path.join(BASE_DIR, ".server.pid")
LOG_FILE   = os.path.join(BASE_DIR, ".server.log")

WEB_URL    = f"http://localhost:{WEB_PORT}/sdk-config-analyzer.html"

# ─── Feature keys (dùng cho proxy batch) ─────────────────────────────────────

FEATURE_KEYS = [
    {"key": "bann",                  "name": "Ban Check",      "isEnabled": lambda d: isinstance(d, dict) and d.get("banned") == "true"},
    {"key": "notify",                "name": "Notify",         "isEnabled": lambda d: isinstance(d, dict) and d.get("show") == "true"},
    {"key": "local_push",            "name": "Local Push",     "isEnabled": lambda d: isinstance(d, dict) and len(d.get("data", [])) > 0},
    {"key": "login_channel",         "name": "Login Channel",  "isEnabled": lambda d: isinstance(d, dict) and len(d.get("list", [])) > 0},
    {"key": "translate",             "name": "Translate",      "isEnabled": lambda d: isinstance(d, dict) and d.get("type") == 1},
    {"key": "secure_account_status", "name": "Secure Account", "isEnabled": lambda d: d == 1},
    {"key": "vn_policy_13",          "name": "VN Policy 13",   "isEnabled": lambda d: isinstance(d, dict) and d.get("show") == 1},
    {"key": "appsflyer",             "name": "AppsFlyer",      "isEnabled": lambda d: isinstance(d, dict) and len(d) > 0},
]

# In-memory batch jobs store (shared giữa các request trong cùng process)
batch_jobs = {}

# ─── Logging ─────────────────────────────────────────────────────────────────

def log(msg, also_print=False):
    """Ghi log ra file, tuỳ chọn cũng print ra stdout."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    if also_print:
        print(line)

# ─── Proxy helpers ────────────────────────────────────────────────────────────

def curl_fetch(game_id, platform, country=None):
    """Fetch Bootstrap config cho 1 game + platform + country tuỳ chọn."""
    url = f"https://login-{game_id}.vnggames.net/?do=Bootstrap.show&os={platform}"
    if country:
        url += f"&country={country}"
    cmd = [
        "curl", "-s", "-L", "--max-time", "10",
        "-A", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "-H", "Accept: application/json, text/plain, */*",
        url
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            curl_errors = {6: "DNS failed", 7: "Connection failed", 28: "Timeout", 35: "SSL error", 60: "SSL cert error"}
            err = curl_errors.get(r.returncode, f"curl exit {r.returncode}")
            return None, f"{err}: {r.stderr.strip()}"
        if not r.stdout.strip():
            return None, "Empty response"
        data = json.loads(r.stdout.strip())
        return data, None
    except subprocess.TimeoutExpired:
        return None, "Timeout (15s)"
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {e}"
    except Exception as e:
        return None, str(e)


def aggregate_batch(results, countries):
    """Tổng hợp kết quả batch thành stats per-feature."""
    stats = {}
    success_results = [r for r in results if r["success"]]
    failed_results  = [r for r in results if not r["success"]]

    for f in FEATURE_KEYS:
        key = f["key"]
        enabled   = [r["gameId"] for r in success_results if r["features"][key]["default"]["enabled"]]
        disabled  = [r["gameId"] for r in success_results if not r["features"][key]["default"]["enabled"]]
        a_enabled = [r["gameId"] for r in success_results if r["features"][key]["default"]["android"]]
        i_enabled = [r["gameId"] for r in success_results if r["features"][key]["default"]["ios"]]

        country_stats = {}
        for c in countries:
            country_stats[c] = {
                "enabled":  len([r for r in success_results if r["features"][key].get("countries", {}).get(c, {}).get("enabled")]),
                "disabled": len([r for r in success_results if not r["features"][key].get("countries", {}).get(c, {}).get("enabled")]),
                "android":  len([r for r in success_results if r["features"][key].get("countries", {}).get(c, {}).get("android")]),
                "ios":      len([r for r in success_results if r["features"][key].get("countries", {}).get(c, {}).get("ios")]),
            }

        stats[key] = {
            "name":               f["name"],
            "enabledCount":       len(enabled),
            "disabledCount":      len(disabled),
            "androidEnabledCount": len(a_enabled),
            "iosEnabledCount":    len(i_enabled),
            "enabledGames":       enabled,
            "disabledGames":      disabled,
            "failedGames":        [r["gameId"] for r in failed_results],
            "countryStats":       country_stats,
        }
    return stats


def run_batch_job(job_id, game_ids, countries):
    """Worker chạy trong background thread, xử lý batch fetch."""
    job = batch_jobs[job_id]

    def fetch_one(game_id):
        slots = [None] + countries
        tasks = [(p, c) for p in ("android", "ios") for c in slots]
        fetched = {}
        with ThreadPoolExecutor(max_workers=min(len(tasks), 6)) as ex:
            futs = {ex.submit(curl_fetch, game_id, p, c): (p, c) for p, c in tasks}
            for fut in as_completed(futs):
                p, c = futs[fut]
                fetched[(p, c if c else "default")] = fut.result()

        a_def_data, a_def_err = fetched.get(("android", "default"), (None, "not fetched"))
        i_def_data, i_def_err = fetched.get(("ios",     "default"), (None, "not fetched"))
        if a_def_data is None and i_def_data is None:
            return {"gameId": game_id, "success": False,
                    "error": f"android: {a_def_err} | ios: {i_def_err}"}

        features = {}
        for f in FEATURE_KEYS:
            key   = f["key"]
            a_d   = fetched.get(("android", "default"), (None, None))[0]
            i_d   = fetched.get(("ios",     "default"), (None, None))[0]
            a_ok  = f["isEnabled"](a_d.get(key) if a_d else None)
            i_ok  = f["isEnabled"](i_d.get(key) if i_d else None)
            feat  = {"default": {"android": a_ok, "ios": i_ok, "enabled": a_ok or i_ok}, "countries": {}}
            for c in countries:
                ca = fetched.get(("android", c), (None, None))[0]
                ci = fetched.get(("ios",     c), (None, None))[0]
                ca_ok = f["isEnabled"](ca.get(key) if ca else None)
                ci_ok = f["isEnabled"](ci.get(key) if ci else None)
                feat["countries"][c] = {"android": ca_ok, "ios": ci_ok, "enabled": ca_ok or ci_ok}
            features[key] = feat

        return {"gameId": game_id, "success": True, "features": features, "countries": countries}

    results = []
    with ThreadPoolExecutor(max_workers=min(5, len(game_ids))) as executor:
        futures = {executor.submit(fetch_one, gid): gid for gid in game_ids}
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            job["completed"] += 1
            if not result["success"]:
                job["failed"] += 1
            job["results"] = results
            job["stats"]   = aggregate_batch(results, countries)
            status_str     = "OK" if result["success"] else "FAIL"
            log(f"[batch:{job_id}] {job['completed']}/{job['total']} — {result['gameId']} ({status_str})")

    job["status"]   = "done"
    job["duration"] = round(time.time() - job["startTime"], 1)
    log(f"[batch:{job_id}] Done in {job['duration']}s — {job['failed']} failed")

# ─── Web Server Handler ───────────────────────────────────────────────────────

class WebHandler(http.server.SimpleHTTPRequestHandler):
    """Serve static files (HTML, JS, CSS, JSON) với CORS headers."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        if any(x in args[0] for x in (".html", ".js", ".css", ".json")):
            log(f"[web] {args[0]}")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

# ─── Proxy Server Handler ─────────────────────────────────────────────────────

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    """Xử lý Bootstrap API proxy và batch jobs."""

    def log_message(self, format, *args):
        log(f"[proxy] {format % args}")

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        # GET /api/config?gameId=xxx&platform=android[&country=VN]
        if parsed.path == "/api/config":
            params   = parse_qs(parsed.query)
            game_id  = params.get("gameId",   [None])[0]
            platform = params.get("platform", ["android"])[0]
            country  = params.get("country",  [None])[0]
            if platform not in ("android", "ios"):
                platform = "android"
            if not game_id:
                self._json_error(400, "Missing gameId parameter"); return
            url = f"https://login-{game_id}.vnggames.net/?do=Bootstrap.show&os={platform}"
            if country:
                url += f"&country={country}"
            log(f"[proxy] fetch [{platform}{'|'+country if country else ''}]: {url}")
            data, err = curl_fetch(game_id, platform, country)
            if err:
                self._json_error(502, err, {"url": url}); return
            self._json(200, {"success": True, "gameId": game_id, "platform": platform,
                             "country": country, "url": url, "data": data})
            return

        # GET /api/batch/status?jobId=xxx
        if parsed.path == "/api/batch/status":
            params = parse_qs(parsed.query)
            job_id = params.get("jobId", [None])[0]
            if not job_id or job_id not in batch_jobs:
                self._json_error(404, "Job not found"); return
            self._json(200, batch_jobs[job_id]); return

        self._json_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)

        # POST /api/batch  body: {"filepath": "...", "countries": ["VN", "TH"]}
        if parsed.path == "/api/batch":
            length = int(self.headers.get("Content-Length", 0))
            body   = self.rfile.read(length)
            try:
                payload = json.loads(body)
            except Exception:
                self._json_error(400, "Invalid JSON body"); return

            filepath  = payload.get("filepath", "").strip()
            countries = payload.get("countries", [])

            if not filepath:
                self._json_error(400, "Missing filepath"); return

            filepath = os.path.abspath(os.path.expanduser(filepath))
            log(f"[proxy] batch file: {filepath}, countries: {countries}")

            if not os.path.isfile(filepath):
                parent = os.path.dirname(filepath)
                hint   = f"Files in {parent}: {os.listdir(parent)[:10]}" if os.path.isdir(parent) else f"Parent dir not found: {parent}"
                self._json_error(404, f"File not found: {filepath}", {"hint": hint}); return

            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            game_ids = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
            if not game_ids:
                self._json_error(400, "No game IDs found in file"); return

            job_id = str(uuid.uuid4())[:8]
            batch_jobs[job_id] = {
                "jobId": job_id, "status": "running",
                "total": len(game_ids), "completed": 0, "failed": 0,
                "countries": countries, "startTime": time.time(),
                "duration": None, "results": [], "stats": {},
            }
            threading.Thread(target=run_batch_job, args=(job_id, game_ids, countries), daemon=True).start()
            self._json(202, {"jobId": job_id, "total": len(game_ids), "status": "running", "countries": countries})
            return

        self._json_error(404, "Not found")

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status, message, extra=None):
        body = {"success": False, "error": message}
        if extra:
            body.update(extra)
        self._json(status, body)

# ─── Server runners ───────────────────────────────────────────────────────────

def _make_tcp_server(port, handler_class):
    """Tạo TCPServer với allow_reuse_address."""
    server = socketserver.TCPServer(("", port), handler_class)
    server.allow_reuse_address = True
    return server


def run_servers(open_browser=True):
    """
    Khởi động Web Server và Proxy Server song song trong 2 threads.
    Hàm này block cho đến khi nhận SIGTERM/SIGINT hoặc gọi server.shutdown().
    """
    os.chdir(BASE_DIR)

    web_server   = _make_tcp_server(WEB_PORT,   WebHandler)
    proxy_server = _make_tcp_server(PROXY_PORT, ProxyHandler)

    log(f"Web   server started  → http://localhost:{WEB_PORT}", also_print=True)
    log(f"Proxy server started  → http://localhost:{PROXY_PORT}", also_print=True)

    web_thread   = threading.Thread(target=web_server.serve_forever,   daemon=True)
    proxy_thread = threading.Thread(target=proxy_server.serve_forever, daemon=True)
    web_thread.start()
    proxy_thread.start()

    if open_browser:
        def _open():
            time.sleep(1.0)
            webbrowser.open(WEB_URL)
            log(f"Browser opened → {WEB_URL}", also_print=True)
        threading.Thread(target=_open, daemon=True).start()

    # Block main thread, chờ signal
    try:
        while True:
            time.sleep(1)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        web_server.shutdown()
        proxy_server.shutdown()
        log("Both servers stopped.", also_print=True)

# ─── Daemon control ───────────────────────────────────────────────────────────

def _read_pid():
    """Đọc PID từ file. Trả về int hoặc None."""
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return None


def _write_pid(pid):
    with open(PID_FILE, "w") as f:
        f.write(str(pid))


def _remove_pid():
    try:
        os.remove(PID_FILE)
    except Exception:
        pass


def _is_running(pid):
    """Kiểm tra process pid có đang chạy không."""
    if pid is None:
        return False
    try:
        os.kill(pid, 0)   # signal 0 = kiểm tra sự tồn tại, không kill
        return True
    except (ProcessLookupError, PermissionError):
        return False


def cmd_start():
    pid = _read_pid()
    if _is_running(pid):
        print(f"  ⚠️  Server đang chạy  (PID {pid})")
        print(f"      Web   → http://localhost:{WEB_PORT}")
        print(f"      Proxy → http://localhost:{PROXY_PORT}")
        return

    # Fork process con chạy nền
    child = os.fork()
    if child > 0:
        # Process cha: ghi PID và thoát
        _write_pid(child)
        time.sleep(0.5)   # chờ con khởi động
        print(f"  ✅  Server đã khởi động  (PID {child})")
        print(f"      Web   → {WEB_URL}")
        print(f"      Proxy → http://localhost:{PROXY_PORT}")
        print(f"      Log   → {LOG_FILE}")
        return

    # Process con: tách khỏi terminal
    os.setsid()
    # Redirect stdin/stdout/stderr sang /dev/null (daemon convention)
    with open(os.devnull, "r") as devnull:
        os.dup2(devnull.fileno(), sys.stdin.fileno())
    with open(LOG_FILE, "a") as logf:
        os.dup2(logf.fileno(), sys.stdout.fileno())
        os.dup2(logf.fileno(), sys.stderr.fileno())

    log(f"=== Daemon started (PID {os.getpid()}) ===", also_print=True)

    def _on_term(sig, frame):
        log("SIGTERM received, shutting down...")
        _remove_pid()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _on_term)

    run_servers(open_browser=False)   # daemon không mở browser
    _remove_pid()
    sys.exit(0)


def cmd_stop():
    pid = _read_pid()
    if not _is_running(pid):
        print("  ℹ️  Server không chạy.")
        _remove_pid()
        return
    try:
        os.kill(pid, signal.SIGTERM)
        # Chờ tối đa 5s để process thoát
        for _ in range(50):
            time.sleep(0.1)
            if not _is_running(pid):
                break
        if _is_running(pid):
            os.kill(pid, signal.SIGKILL)
            print(f"  ⚠️  Đã force-kill PID {pid}")
        else:
            print(f"  ✅  Server đã dừng  (PID {pid})")
        _remove_pid()
    except Exception as e:
        print(f"  ❌  Lỗi khi dừng: {e}")


def cmd_restart():
    print("  🔄  Restarting...")
    cmd_stop()
    time.sleep(0.5)
    cmd_start()


def cmd_status():
    pid = _read_pid()
    if _is_running(pid):
        print(f"  🟢  Running  (PID {pid})")
        print(f"      Web   → {WEB_URL}")
        print(f"      Proxy → http://localhost:{PROXY_PORT}")
        print(f"      Log   → {LOG_FILE}")
    else:
        print("  🔴  Stopped")
        _remove_pid()


def cmd_run():
    """Chạy foreground — không daemon, log ra stdout, mở browser."""
    _banner()
    print("  Nhấn Ctrl+C để dừng\n")
    run_servers(open_browser=True)


def _banner():
    sep = "─" * 54
    print(f"\n  {sep}")
    print(f"  SDK Config Analyzer — Unified Server")
    print(f"  {sep}")
    print(f"  Web   server : http://localhost:{WEB_PORT}")
    print(f"  Proxy server : http://localhost:{PROXY_PORT}")
    print(f"  App URL      : {WEB_URL}")
    print(f"  Base dir     : {BASE_DIR}")
    print(f"  {sep}")

# ─── Entrypoint ───────────────────────────────────────────────────────────────

COMMANDS = {
    "start":   cmd_start,
    "stop":    cmd_stop,
    "restart": cmd_restart,
    "status":  cmd_status,
    "run":     cmd_run,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd not in COMMANDS:
        _banner()
        print()
        print("  Usage:")
        print("    python3 server.py start     # Khởi daemon (chạy nền)")
        print("    python3 server.py stop      # Dừng daemon")
        print("    python3 server.py restart   # Restart daemon")
        print("    python3 server.py status    # Kiểm tra trạng thái")
        print("    python3 server.py run       # Chạy foreground (debug)")
        print()
        sys.exit(1)

    COMMANDS[cmd]()
