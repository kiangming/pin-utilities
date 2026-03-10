#!/usr/bin/env python3
"""
SDK Config Proxy Server
Fetch VNGGames Bootstrap API with platform + country support

Usage: python3 proxy.py
Then open: http://localhost:8765
"""

import subprocess
import json
import threading
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
import os

PORT = 8765
HTML_FILE = os.path.join(os.path.dirname(__file__), "sdk-config-analyzer.html")

batch_jobs = {}

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


def curl_fetch(game_id, platform, country=None):
    """Fetch config for one game + platform + optional country. Returns (data_dict, error_str)."""
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


class ProxyHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[{self.address_string()}] {format % args}")

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

        if parsed.path in ("/", "/index.html"):
            self.serve_html(); return

        # GET /api/config?gameId=xxx&platform=android&country=VN (country optional)
        if parsed.path == "/api/config":
            params = parse_qs(parsed.query)
            game_id = params.get("gameId", [None])[0]
            platform = params.get("platform", ["android"])[0]
            country  = params.get("country",  [None])[0]
            if platform not in ("android", "ios"):
                platform = "android"
            if not game_id:
                self.send_json_error(400, "Missing gameId parameter"); return
            url = f"https://login-{game_id}.vnggames.net/?do=Bootstrap.show&os={platform}"
            if country:
                url += f"&country={country}"
            print(f"  → fetch [{platform}{'|'+country if country else ''}]: {url}")
            data, err = curl_fetch(game_id, platform, country)
            if err:
                self.send_json_error(502, err, {"url": url}); return
            self.send_json(200, {"success": True, "gameId": game_id, "platform": platform,
                                 "country": country, "url": url, "data": data})
            return

        # GET /api/batch/status?jobId=xxx
        if parsed.path == "/api/batch/status":
            params = parse_qs(parsed.query)
            job_id = params.get("jobId", [None])[0]
            if not job_id or job_id not in batch_jobs:
                self.send_json_error(404, "Job not found"); return
            self.send_json(200, batch_jobs[job_id]); return

        self.send_json_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/batch":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                payload = json.loads(body)
            except Exception:
                self.send_json_error(400, "Invalid JSON body"); return

            filepath  = payload.get("filepath", "").strip()
            countries = payload.get("countries", [])  # list of country codes, e.g. ["VN","TH"]

            if not filepath:
                self.send_json_error(400, "Missing filepath"); return

            filepath = os.path.expanduser(filepath)
            filepath = os.path.abspath(filepath)
            print(f"  → batch file resolved: {filepath}")
            if countries:
                print(f"  → countries: {', '.join(countries)}")

            if not os.path.isfile(filepath):
                parent = os.path.dirname(filepath)
                hint = f"Files in {parent}: {os.listdir(parent)[:10]}" if os.path.isdir(parent) else f"Parent dir not found: {parent}"
                self.send_json_error(404, f"File not found: {filepath}", {"hint": hint}); return

            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()

            game_ids = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
            if not game_ids:
                self.send_json_error(400, "No game IDs found in file"); return

            job_id = str(uuid.uuid4())[:8]
            batch_jobs[job_id] = {
                "jobId":     job_id,
                "status":    "running",
                "total":     len(game_ids),
                "completed": 0,
                "failed":    0,
                "countries": countries,
                "startTime": time.time(),
                "duration":  None,
                "results":   [],
                "stats":     {},
            }

            t = threading.Thread(target=self.run_batch, args=(job_id, game_ids, countries), daemon=True)
            t.start()
            self.send_json(202, {"jobId": job_id, "total": len(game_ids), "status": "running",
                                 "countries": countries})
            return

        self.send_json_error(404, "Not found")

    def run_batch(self, job_id, game_ids, countries):
        job = batch_jobs[job_id]
        results = []

        def fetch_one(game_id):
            # Fetch default (no country) + mỗi country, cho cả 2 platforms
            slots = [None] + countries  # None = default (không có country param)

            # Tạo tất cả tasks: (platform, country_or_None)
            tasks = [(p, c) for p in ("android", "ios") for c in slots]

            fetched = {}  # key: (platform, slot_label) → data
            with ThreadPoolExecutor(max_workers=min(len(tasks), 6)) as ex:
                futs = {ex.submit(curl_fetch, game_id, p, c): (p, c) for p, c in tasks}
                for fut in as_completed(futs):
                    p, c = futs[fut]
                    slot_label = c if c else "default"
                    data, err = fut.result()
                    fetched[(p, slot_label)] = (data, err)

            # Kiểm tra nếu cả default android và ios đều fail
            a_def_data, a_def_err = fetched.get(("android", "default"), (None, "not fetched"))
            i_def_data, i_def_err = fetched.get(("ios", "default"), (None, "not fetched"))
            if a_def_data is None and i_def_data is None:
                return {"gameId": game_id, "success": False,
                        "error": f"android: {a_def_err} | ios: {i_def_err}"}

            # Build features structure
            # features[key] = {
            #   "default": { "android": bool, "ios": bool, "enabled": bool },
            #   "countries": { "VN": { "android": bool, "ios": bool }, ... }
            # }
            features = {}
            for f in FEATURE_KEYS:
                key = f["key"]
                feat = {"default": {}, "countries": {}}

                # default slot
                a_data = fetched.get(("android", "default"), (None, None))[0]
                i_data = fetched.get(("ios", "default"), (None, None))[0]
                a_ok = f["isEnabled"](a_data.get(key) if a_data else None)
                i_ok = f["isEnabled"](i_data.get(key) if i_data else None)
                feat["default"] = {
                    "android": a_ok,
                    "ios":     i_ok,
                    "enabled": a_ok or i_ok,
                }

                # country slots
                for c in countries:
                    ca_data = fetched.get(("android", c), (None, None))[0]
                    ci_data = fetched.get(("ios", c), (None, None))[0]
                    ca_ok = f["isEnabled"](ca_data.get(key) if ca_data else None)
                    ci_ok = f["isEnabled"](ci_data.get(key) if ci_data else None)
                    feat["countries"][c] = {
                        "android": ca_ok,
                        "ios":     ci_ok,
                        "enabled": ca_ok or ci_ok,
                    }

                features[key] = feat

            return {
                "gameId":   game_id,
                "success":  True,
                "features": features,
                "countries": countries,
            }

        max_workers = min(5, len(game_ids))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(fetch_one, gid): gid for gid in game_ids}
            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                job["completed"] += 1
                if not result["success"]:
                    job["failed"] += 1
                job["results"] = results
                job["stats"]   = self.aggregate(results, countries)
                status = "OK" if result["success"] else "FAIL"
                print(f"  [batch:{job_id}] {job['completed']}/{job['total']} — {result['gameId']} ({status})")

        job["status"]   = "done"
        job["duration"] = round(time.time() - job["startTime"], 1)
        print(f"  [batch:{job_id}] Done in {job['duration']}s — {job['failed']} failed")

    def aggregate(self, results, countries):
        stats = {}
        success_results = [r for r in results if r["success"]]
        failed_results  = [r for r in results if not r["success"]]

        for f in FEATURE_KEYS:
            key = f["key"]

            # Default slot aggregation (OR logic cho enabled)
            enabled  = [r["gameId"] for r in success_results if r["features"][key]["default"]["enabled"]]
            disabled = [r["gameId"] for r in success_results if not r["features"][key]["default"]["enabled"]]
            a_enabled = [r["gameId"] for r in success_results if r["features"][key]["default"]["android"]]
            i_enabled = [r["gameId"] for r in success_results if r["features"][key]["default"]["ios"]]

            # Per-country aggregation
            country_stats = {}
            for c in countries:
                c_enabled = [r["gameId"] for r in success_results
                             if r["features"][key].get("countries", {}).get(c, {}).get("enabled")]
                c_disabled = [r["gameId"] for r in success_results
                              if not r["features"][key].get("countries", {}).get(c, {}).get("enabled")]
                c_android  = [r["gameId"] for r in success_results
                              if r["features"][key].get("countries", {}).get(c, {}).get("android")]
                c_ios      = [r["gameId"] for r in success_results
                              if r["features"][key].get("countries", {}).get(c, {}).get("ios")]
                country_stats[c] = {
                    "enabled":  len(c_enabled),
                    "disabled": len(c_disabled),
                    "android":  len(c_android),
                    "ios":      len(c_ios),
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

    def serve_html(self):
        try:
            with open(HTML_FILE, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_json_error(404, f"HTML file not found: {HTML_FILE}")

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_json_error(self, status, message, extra=None):
        body = {"success": False, "error": message}
        if extra:
            body.update(extra)
        self.send_json(status, body)


if __name__ == "__main__":
    print(f"")
    print(f"  🦞 SDK Config Proxy Server  (platform + country aware)")
    print(f"  ────────────────────────────────────────────────────────")
    print(f"  URL:    http://localhost:{PORT}")
    print(f"  APIs:")
    print(f"    GET  /api/config?gameId=demovn&platform=android")
    print(f"    GET  /api/config?gameId=demovn&platform=ios&country=VN")
    print(f"    POST /api/batch  (body: {{filepath: '...', countries: ['VN','TH']}})")
    print(f"    GET  /api/batch/status?jobId=xxx")
    print(f"")
    print(f"  Press Ctrl+C to stop")
    print(f"")
    server = HTTPServer(("localhost", PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
