"""工程データを形式に照らして検査し、根拠の発言が文字起こしに実在するか確かめる。

使い方: python validate.py <工程データ> <スキーマ> [文字起こしの親フォルダ]
文字起こしは公開しないので、親フォルダを省くと実在の検査は飛ばす。
"""
import json
import sys
from pathlib import Path

from jsonschema import validate

TOLERANCE_SEC = 15


def evidences(node):
    if isinstance(node, dict):
        if {"run", "at_sec", "quote"} <= node.keys():
            yield node
        for value in node.values():
            yield from evidences(value)
    elif isinstance(node, list):
        for value in node:
            yield from evidences(value)


def load_rows(folder: Path) -> list[dict]:
    lines = (folder / "transcript_loose.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines]


def said(rows: list[dict], at_sec: float, quote: str) -> bool:
    for row in rows:
        near = row["start"] - TOLERANCE_SEC <= at_sec <= row["end"] + TOLERANCE_SEC
        if near and quote in row["text"]:
            return True
    return False


def validate_schema(data: dict, schema: dict) -> None:
    validate(data, schema)
    for step in data["steps"]:
        for criterion in step["criteria"]:
            if criterion["kind"] == "sight" and not criterion.get("visual_question"):
                raise ValueError(f"{step['id']}: sight の基準に visual_question がありません")


def check_evidence(data: dict, rows_by_run: dict[str, list[dict]]) -> list[dict]:
    return [
        item
        for item in evidences(data["steps"])
        if item["run"] not in rows_by_run or not said(rows_by_run[item["run"]], item["at_sec"], item["quote"])
    ]


def main() -> int:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    schema = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    validate_schema(data, schema)
    total = len(list(evidences(data["steps"])))
    print(f"形式 OK: 工程 {len(data['steps'])} 件、根拠 {total} 件")
    if len(sys.argv) < 4:
        return 0
    folders = sorted(p for p in Path(sys.argv[3]).iterdir() if p.is_dir())
    rows = {f"run{i}": load_rows(folder) for i, folder in enumerate(folders, start=1)}
    missing = check_evidence(data, rows)
    for item in missing:
        print("根拠が見つからない:", item)
    print(f"根拠の実在: {total - len(missing)}/{total}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
