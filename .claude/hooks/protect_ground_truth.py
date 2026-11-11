#!/usr/bin/env python3
"""PreToolUse hook: block Claude Code from editing eval ground truth.

Claude Code passes the tool call as JSON on stdin. Exit code 2 blocks the call and
shows stderr to the model. Note: this only covers the file-editing tools. A Bash
command could still write there, so the rule is also in CLAUDE.md.
"""
import json
import sys

PROTECTED = "evals/faults/"

data = json.load(sys.stdin)
tool_input = data.get("tool_input", {}) or {}
path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")

if PROTECTED in path.replace("\\", "/"):
    print(
        f"Blocked: {path} is eval ground truth and is human-owned. "
        "Ask Sid to change it instead.",
        file=sys.stderr,
    )
    sys.exit(2)

sys.exit(0)
