"""Write the answer from a `claude -p --output-format stream-json` event file.

Usage: python3 -I stream-result.py <stream file> <out file>
Exit 0 after writing the last result event's text; exit 1 if there is no successful result event.
"""
import json
import sys


def last_result(path):
    result = None
    with open(path, encoding="utf-8", errors="replace") as events:
        for line in events:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") == "result":
                result = event
    return result


def main(stream, out):
    result = last_result(stream)
    if result is None or result.get("is_error") or not isinstance(result.get("result"), str):
        return 1
    with open(out, "w", encoding="utf-8") as answer:
        answer.write(result["result"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
