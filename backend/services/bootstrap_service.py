"""
Bootstrap API service: fetch VNGGames Bootstrap config + batch jobs.
Ported from server.py — logic giữ nguyên, chỉ tách thành module riêng.
"""
import json
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

# In-memory job store (tồn tại trong process)
_batch_jobs: dict[str, dict] = {}

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


def fetch_config(game_id: str, platform: str, country: str | None = None) -> tuple[dict | None, str | None]:
    """Fetch Bootstrap config cho 1 game + platform + country."""
    url = f"https://login-{game_id}.vnggames.net/?do=Bootstrap.show&os={platform}"
    if country:
        url += f"&country={country}"
    cmd = [
        "curl", "-s", "-L", "--max-time", "10",
        "-A", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "-H", "Accept: application/json, text/plain, */*",
        url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            curl_errors = {6: "DNS failed", 7: "Connection refused", 28: "Timeout", 35: "SSL error", 60: "SSL cert error"}
            err = curl_errors.get(r.returncode, f"curl exit {r.returncode}")
            return None, f"{err}: {r.stderr.strip()}"
        if not r.stdout.strip():
            return None, "Empty response"
        return json.loads(r.stdout.strip()), None
    except subprocess.TimeoutExpired:
        return None, "Timeout (15s)"
    except json.JSONDecodeError as e:
        return None, f"JSON parse error: {e}"
    except Exception as e:
        return None, str(e)


def get_job(job_id: str) -> dict | None:
    return _batch_jobs.get(job_id)


def start_batch(game_ids: list[str], countries: list[str]) -> str:
    job_id = uuid.uuid4().hex[:8]
    _batch_jobs[job_id] = {
        "jobId": job_id,
        "status": "running",
        "total": len(game_ids),
        "completed": 0,
        "failed": 0,
        "countries": countries,
        "startTime": time.time(),
        "duration": None,
        "results": [],
        "stats": {},
    }
    threading.Thread(target=_run_batch, args=(job_id, game_ids, countries), daemon=True).start()
    return job_id


def _run_batch(job_id: str, game_ids: list[str], countries: list[str]):
    job = _batch_jobs[job_id]

    def fetch_one(game_id: str) -> dict:
        slots = [None] + countries
        tasks = [(p, c) for p in ("android", "ios") for c in slots]
        fetched: dict[tuple, tuple] = {}
        with ThreadPoolExecutor(max_workers=min(len(tasks), 6)) as ex:
            futs = {ex.submit(fetch_config, game_id, p, c): (p, c) for p, c in tasks}
            for fut in as_completed(futs):
                p, c = futs[fut]
                fetched[(p, c if c else "default")] = fut.result()

        a_data, a_err = fetched.get(("android", "default"), (None, "not fetched"))
        i_data, i_err = fetched.get(("ios",     "default"), (None, "not fetched"))
        if a_data is None and i_data is None:
            return {"gameId": game_id, "success": False,
                    "error": f"android: {a_err} | ios: {i_err}"}

        features: dict = {}
        for f in FEATURE_KEYS:
            key = f["key"]
            a_ok = f["isEnabled"](a_data.get(key) if a_data else None)
            i_ok = f["isEnabled"](i_data.get(key) if i_data else None)
            feat: dict = {"default": {"android": a_ok, "ios": i_ok, "enabled": a_ok or i_ok}, "countries": {}}
            for c in countries:
                ca, _ = fetched.get(("android", c), (None, None))
                ci, _ = fetched.get(("ios",     c), (None, None))
                ca_ok = f["isEnabled"](ca.get(key) if ca else None)
                ci_ok = f["isEnabled"](ci.get(key) if ci else None)
                feat["countries"][c] = {"android": ca_ok, "ios": ci_ok, "enabled": ca_ok or ci_ok}
            features[key] = feat

        return {"gameId": game_id, "success": True, "features": features, "countries": countries}

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(5, len(game_ids))) as executor:
        futures = {executor.submit(fetch_one, gid): gid for gid in game_ids}
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            job["completed"] += 1
            if not result["success"]:
                job["failed"] += 1
            job["results"] = results
            job["stats"] = _aggregate(results, countries)

    job["status"] = "done"
    job["duration"] = round(time.time() - job["startTime"], 1)


def _aggregate(results: list[dict], countries: list[str]) -> dict:
    ok = [r for r in results if r["success"]]
    fail = [r for r in results if not r["success"]]
    stats: dict = {}
    for f in FEATURE_KEYS:
        key = f["key"]
        enabled  = [r["gameId"] for r in ok if r["features"][key]["default"]["enabled"]]
        disabled = [r["gameId"] for r in ok if not r["features"][key]["default"]["enabled"]]
        a_en = [r["gameId"] for r in ok if r["features"][key]["default"]["android"]]
        i_en = [r["gameId"] for r in ok if r["features"][key]["default"]["ios"]]
        cs: dict = {}
        for c in countries:
            cs[c] = {
                "enabled":  len([r for r in ok if r["features"][key].get("countries", {}).get(c, {}).get("enabled")]),
                "disabled": len([r for r in ok if not r["features"][key].get("countries", {}).get(c, {}).get("enabled")]),
                "android":  len([r for r in ok if r["features"][key].get("countries", {}).get(c, {}).get("android")]),
                "ios":      len([r for r in ok if r["features"][key].get("countries", {}).get(c, {}).get("ios")]),
            }
        stats[key] = {
            "name": f["name"],
            "enabledCount": len(enabled),
            "disabledCount": len(disabled),
            "androidEnabledCount": len(a_en),
            "iosEnabledCount": len(i_en),
            "enabledGames": enabled,
            "disabledGames": disabled,
            "failedGames": [r["gameId"] for r in fail],
            "countryStats": cs,
        }
    return stats
