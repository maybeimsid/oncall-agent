"""Spike: does qwen3.5:9b do tool calling reliably in Ollama?

Throwaway code. Stdlib only. Run with: python3 spikes/tool_calling/spike.py
Env overrides: MODEL, OLLAMA_URL, RUNS.
"""

import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

MODEL = os.environ.get("MODEL", "qwen3.5:9b")
URL = os.environ.get("OLLAMA_URL", "http://localhost:11434") + "/api/chat"
RUNS = int(os.environ.get("RUNS", "10"))
NUM_CTX = 16384
TIMEOUT_S = 120
HERE = os.path.dirname(os.path.abspath(__file__))

SYSTEM = (
    "You are an on-call assistant for an online shop made of microservices. "
    "Use tools only when the question needs live telemetry."
)

SERVICES = "payment, checkout, cart, frontend, shipping, currency, product-catalog, recommendation, ad, email, quote"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_error_rate",
            "description": (
                "Get the fraction of failed requests (0.0 to 1.0) for one service over "
                "the last 5 minutes. Use this to check whether a service is failing or erroring."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "service": {
                        "type": "string",
                        "description": f"Service name, lowercase. Known services: {SERVICES}.",
                    }
                },
                "required": ["service"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_p95_latency",
            "description": (
                "Get the p95 request latency in milliseconds for one service over the "
                "last 5 minutes. Use this to check whether a service is slow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "service": {
                        "type": "string",
                        "description": f"Service name, lowercase. Known services: {SERVICES}.",
                    }
                },
                "required": ["service"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_recent_changes",
            "description": (
                "List deploys and feature flag changes across all services in the last N "
                "minutes. Use this to find what changed before an incident."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "minutes": {
                        "type": "integer",
                        "description": "How far back to look, in minutes.",
                        "minimum": 1,
                        "maximum": 1440,
                    }
                },
                "required": ["minutes"],
                "additionalProperties": False,
            },
        },
    },
]
SCHEMAS = {t["function"]["name"]: t["function"]["parameters"] for t in TOOLS}

FAKE_RESULT = {"service": "payment", "error_rate": 0.237}
NUMBER_PATTERNS = [r"0\.237", r"23\.7", r"\b24\s*%"]

CASES = [
    {"id": "1", "prompt": "Is payment failing?", "tool": "get_error_rate", "args": {"service": "payment"}},
    {"id": "2", "prompt": "Is checkout slow?", "tool": "get_p95_latency", "args": {"service": "checkout"}},
    {
        "id": "3",
        "prompt": "Did anything change in the last 30 minutes?",
        "tool": "list_recent_changes",
        "args": {"minutes": 30},
    },
    {"id": "4", "prompt": "What's the capital of France?", "tool": None, "args": None},
]
TWO_STEP_PROMPT = "What is the error rate of payment?"


class Fatal(Exception):
    pass


def chat(messages):
    """POST /api/chat. Returns (response_dict or None, wall_ms, error_str or None)."""
    body = {
        "model": MODEL,
        "stream": False,
        "think": False,
        "tools": TOOLS,
        "messages": messages,
        "options": {"num_ctx": NUM_CTX},
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        raise Fatal(f"HTTP {e.code}: {e.read().decode()[:500]}")
    except urllib.error.URLError as e:
        if isinstance(e.reason, ConnectionRefusedError):
            raise Fatal(f"connection refused at {URL}. Is `ollama serve` running?")
        if isinstance(e.reason, TimeoutError):
            return None, (time.monotonic() - t0) * 1000, f"timeout after {TIMEOUT_S}s"
        raise Fatal(f"URL error: {e.reason}")
    except TimeoutError:
        return None, (time.monotonic() - t0) * 1000, f"timeout after {TIMEOUT_S}s"
    wall_ms = (time.monotonic() - t0) * 1000
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None, wall_ms, f"bad JSON: {raw[:200]}"
    if not isinstance(data.get("message"), dict):
        return None, wall_ms, f"no message: {raw[:200]}"
    return data, wall_ms, None


def validate_args(args, schema):
    """Tiny JSON Schema subset check. Returns list of problems (empty = valid)."""
    if not isinstance(args, dict):
        return [f"args not an object: {type(args).__name__}"]
    problems = []
    props = schema["properties"]
    for key in schema.get("required", []):
        if key not in args:
            problems.append(f"missing {key}")
    for key, val in args.items():
        if key not in props:
            problems.append(f"extra key {key}")
            continue
        p = props[key]
        if p["type"] == "string" and not isinstance(val, str):
            problems.append(f"{key} not string")
        if p["type"] == "integer":
            if isinstance(val, bool) or not isinstance(val, int):
                problems.append(f"{key} not integer ({val!r})")
            else:
                if "minimum" in p and val < p["minimum"]:
                    problems.append(f"{key} below minimum")
                if "maximum" in p and val > p["maximum"]:
                    problems.append(f"{key} above maximum")
    return problems


def parse_calls(message):
    """Normalize tool_calls. Returns list of dicts with name, args, id, quirks."""
    out = []
    for tc in message.get("tool_calls") or []:
        fn = tc.get("function") or {}
        args = fn.get("arguments")
        quirks = []
        if isinstance(args, str):
            quirks.append("args_as_string")
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                quirks.append("args_unparseable")
        out.append({"name": fn.get("name"), "args": args, "id": tc.get("id"), "quirks": quirks})
    return out


def score_tool_turn(data, expected_tool, expected_args):
    msg = data["message"]
    calls = parse_calls(msg)
    rec = {
        "calls": [{"name": c["name"], "args": c["args"], "id": c["id"], "quirks": c["quirks"]} for c in calls],
        "content": (msg.get("content") or "")[:300],
        "hallucinated": any(c["name"] not in SCHEMAS for c in calls),
    }
    if expected_tool is None:
        rec["correct_tool"] = len(calls) == 0
        rec["schema_valid"] = None
        rec["expected_args"] = None
        return rec
    first = calls[0] if calls else None
    rec["correct_tool"] = first is not None and first["name"] == expected_tool and len(calls) == 1
    if first is not None and first["name"] in SCHEMAS:
        problems = validate_args(first["args"], SCHEMAS[first["name"]])
        rec["schema_valid"] = not problems
        rec["problems"] = problems
    else:
        rec["schema_valid"] = False
    rec["expected_args"] = rec["correct_tool"] and first["args"] == expected_args
    return rec


def add_timing(rec, data, wall_ms):
    rec["wall_ms"] = round(wall_ms, 1)
    if data is None:
        return
    rec["total_ms"] = round(data.get("total_duration", 0) / 1e6, 1)
    rec["load_ms"] = round(data.get("load_duration", 0) / 1e6, 1)
    rec["prompt_eval_count"] = data.get("prompt_eval_count")
    rec["eval_count"] = data.get("eval_count")


def fmt_call(rec):
    if rec.get("error"):
        return f"ERROR {rec['error']}"
    if not rec["calls"]:
        return f"text: {rec['content'][:70]!r}"
    return "; ".join(f"{c['name']}({json.dumps(c['args'])})" for c in rec["calls"])


def log_line(case_id, run, rec):
    ok = "ok  " if rec.get("correct_tool") and rec.get("expected_args") is not False else "FAIL"
    print(
        f"[{case_id:>2} #{run:02d}] {ok} {rec['wall_ms']:>8.0f}ms "
        f"prompt={rec.get('prompt_eval_count')} load={rec.get('load_ms')}ms  {fmt_call(rec)}"
    )


def main():
    records = []

    def run_turn(case_id, run, messages, expected_tool, expected_args):
        data, wall_ms, err = chat(messages)
        if err:
            rec = {"error": err, "correct_tool": False, "schema_valid": False,
                   "expected_args": False, "hallucinated": False, "calls": []}
        else:
            rec = score_tool_turn(data, expected_tool, expected_args)
        rec.update({"case": case_id, "run": run})
        add_timing(rec, data, wall_ms)
        rec["first_call"] = len(records) == 0
        records.append(rec)
        log_line(case_id, run, rec)
        return data, rec

    base = [{"role": "system", "content": SYSTEM}]

    for case in CASES:
        for run in range(1, RUNS + 1):
            msgs = base + [{"role": "user", "content": case["prompt"]}]
            run_turn(case["id"], run, msgs, case["tool"], case["args"])

    ids_seen = []
    for run in range(1, RUNS + 1):
        msgs = base + [{"role": "user", "content": TWO_STEP_PROMPT}]
        data, rec = run_turn("5a", run, msgs, "get_error_rate", {"service": "payment"})
        if not (rec["correct_tool"] and rec["expected_args"]):
            skip = {"case": "5b", "run": run, "error": "skipped, turn 1 wrong", "correct_tool": False,
                    "schema_valid": None, "expected_args": None, "hallucinated": False,
                    "calls": [], "uses_number": False, "wall_ms": 0.0, "skipped": True}
            records.append(skip)
            print(f"[5b #{run:02d}] FAIL skipped, turn 1 wrong")
            continue
        assistant_msg = data["message"]
        call_id = rec["calls"][0]["id"]
        ids_seen.append(call_id is not None)
        tool_msg = {"role": "tool", "tool_name": "get_error_rate", "content": json.dumps(FAKE_RESULT)}
        if call_id:
            tool_msg["tool_call_id"] = call_id
        msgs2 = msgs + [assistant_msg, tool_msg]
        data2, rec2 = run_turn("5b", run, msgs2, None, None)
        text = (data2["message"].get("content") or "") if data2 else ""
        rec2["uses_number"] = any(re.search(p, text) for p in NUMBER_PATTERNS)
        rec2["content"] = text[:300]
        rec2["sent_tool_call_id"] = call_id
        if not rec2["uses_number"]:
            print(f"        5b answer missing number: {text[:120]!r}")

    report(records, ids_seen)


def pct(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return "  n/a"
    return f"{100 * sum(1 for v in vals if v) / len(vals):>4.0f}%"


def report(records, ids_seen):
    real = [r for r in records if not r.get("skipped")]
    cold = real[0] if real else None
    evicted = [r for r in real[1:] if (r.get("load_ms") or 0) > 1000]
    warm_excluded = {id(cold)} | {id(r) for r in evicted}

    print("\n=== Summary ===")
    print(f"model={MODEL} num_ctx={NUM_CTX} think=false runs/case={RUNS}")
    if cold:
        note = " (model was already loaded, not a true cold start)" if (cold.get("load_ms") or 0) < 1000 else ""
        print(f"cold start: load_duration={cold.get('load_ms')}ms wall={cold['wall_ms']:.0f}ms{note}")
    if evicted:
        print(f"WARNING: {len(evicted)} later calls had load_duration > 1s (model reloaded), excluded from warm stats")

    hdr = f"{'case':<5}{'tool ok':>9}{'schema ok':>11}{'args ok':>9}{'halluc':>8}{'number':>8}{'p50 ms':>9}{'max ms':>9}{'p50 tok':>9}{'errors':>8}"
    print(hdr)
    print("-" * len(hdr))
    for cid in ["1", "2", "3", "4", "5a", "5b"]:
        rs = [r for r in records if r["case"] == cid]
        warm = [r["wall_ms"] for r in rs if not r.get("skipped") and not r.get("error") and id(r) not in warm_excluded]
        toks = [r["prompt_eval_count"] for r in rs if r.get("prompt_eval_count") is not None]
        number = pct([r.get("uses_number") for r in rs]) if cid == "5b" else "     "
        errs = sum(1 for r in rs if r.get("error"))
        print(
            f"{cid:<5}{pct([r['correct_tool'] for r in rs]):>9}{pct([r['schema_valid'] for r in rs]):>11}"
            f"{pct([r['expected_args'] for r in rs]):>9}{pct([r['hallucinated'] for r in rs]):>8}{number:>8}"
            f"{(f'{statistics.median(warm):.0f}' if warm else 'n/a'):>9}"
            f"{(f'{max(warm):.0f}' if warm else 'n/a'):>9}"
            f"{(f'{statistics.median(toks):.0f}' if toks else 'n/a'):>9}{errs:>8}"
        )
    print("tool ok: right tool, exactly one call (case 4 and 5b: no call).")
    print("schema ok: args pass the JSON Schema. args ok: args equal the expected values exactly.")
    print("number: 5b final answer contains the number from the tool result.")

    quirks = sorted({q for r in records for c in r.get("calls", []) for q in c.get("quirks", [])})
    print(f"arg quirks seen: {quirks or 'none'}")
    if ids_seen:
        n = sum(ids_seen)
        print(f"tool call ids returned in 5a: {n}/{len(ids_seen)}")
        if n < len(ids_seen):
            print("WARNING: some tool calls had no id; those follow-ups were sent with tool_name only.")

    out = os.path.join(HERE, "results.json")
    with open(out, "w") as f:
        json.dump(records, f, indent=2)
    print(f"raw records: {out}")

    print("\n=== ollama ps ===")
    try:
        ps = subprocess.run(["ollama", "ps"], capture_output=True, text=True, timeout=10)
        print(ps.stdout or ps.stderr)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"could not run ollama ps: {e}")


if __name__ == "__main__":
    try:
        main()
    except Fatal as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
