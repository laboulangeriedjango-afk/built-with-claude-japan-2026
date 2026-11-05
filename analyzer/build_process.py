"""作り手の語りから工程データを作る。--base を渡すと、既存の工程データに新しい仕込みを反映する。

使い方:
  python build_process.py <文字起こしの親フォルダ> <出力> --runs run1 run2 run3
  python build_process.py <文字起こしの親フォルダ> <出力> --base <既存の工程データ> --runs run4
"""
import argparse
import json
import os
import sys
from pathlib import Path

import anthropic

from validate import check_evidence, load_rows, validate_schema

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "shared" / "process.schema.json"
GLOSSARY_PATH = Path(__file__).resolve().parent / "glossary.json"
CORRECTIONS_PATH = Path(__file__).resolve().parent / "corrections.json"
CRAFT_RULES_PATH = Path(__file__).resolve().parent / "craft_rules.json"
MODEL = "claude-opus-5-5"
SPLIT_GAP_SEC = 5
PRICE_PER_MTOK = {"input": 4.0, "output": 20.0}

SYSTEM = """あなたは、パネットーネ職人の語りから本捏ねの工程データを作る編集者です。
入力は、職人が仕込み中に話した言葉の文字起こしです。誤認識を含みます。

守ること:
- 工程、基準、分岐は、語られた内容だけから作る。一般的な製パン知識で補わない
- 語られていない数値を作らない。温度の分岐の値は、発言にある値を使う
- 仕込みをまたいで共通する流れを工程にし、回ごとの違いは基準や分岐にする
- 雑談、作業と無関係な発言、人名は使わない。材料を探す独り言も使わない
- evidence の quote は入力の文字列をそのまま抜き出す。誤認識を直さない。at_sec は入力の秒数を使う
- instruction と text は、誤認識を直した自然な日本語にする。用語集に従う
- 職人の修正は語りより優先する。write_as があれば、その表記を使う
- 読み上げで誤読しやすい表記を避ける
- instruction は作業者への短い指示にする。音声で読み上げるので一文を短くする
- kind が sight の基準には、映像を見て答えられる質問を visual_question に書く。材料の説明や画像全般の分析を求める質問にしない
- 温度は映像から分からない。温度の判断は ask_dough_temp と branches で扱う
- when には温度の範囲か note のどちらかを入れる
- typical_minutes は、各仕込みでその工程が始まった最も早い時刻を min、終わった最も遅い時刻を max として分で書く
"""


def load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip())


def utterances(rows: list[dict]) -> list[tuple[float, str]]:
    """単語の時刻を見て、間が空いた発言を分ける。"""
    result = []
    for row in rows:
        chunk: list[dict] = []
        for word in row["words"]:
            if chunk and word["start"] - chunk[-1]["end"] > SPLIT_GAP_SEC:
                result.append((chunk[0]["start"], "".join(w["word"] for w in chunk)))
                chunk = []
            chunk.append(word)
        if chunk:
            result.append((chunk[0]["start"], "".join(w["word"] for w in chunk)))
    return result


def format_run(name: str, rows: list[dict]) -> str:
    lines = [f"## {name}"]
    for at_sec, text in utterances(rows):
        lines.append(f"[{at_sec:.0f}秒 = {int(at_sec // 60):02d}:{int(at_sec % 60):02d}] {text.strip()}")
    return "\n".join(lines)


def output_schema() -> dict:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    schema["properties"].pop("principles")
    schema["properties"].pop("limits")
    return {key: value for key, value in schema.items() if key not in ("$schema", "title")}


def build_prompt(runs: dict[str, list[dict]], base: dict | None, glossary: dict, corrections: list[dict], rules: dict) -> str:
    parts = [
        "用語集（文字起こしの誤認識 → 正しい語）:",
        json.dumps(glossary, ensure_ascii=False, indent=2),
        "職人の修正:",
        json.dumps(corrections, ensure_ascii=False, indent=2),
        "職人の決まり（工程の指示もこれに合わせる）:",
        json.dumps(rules, ensure_ascii=False, indent=2),
    ]
    if base:
        parts += [
            "現在の工程データ:",
            json.dumps(base, ensure_ascii=False),
            "新しい仕込みの語りを読み、工程データを更新してください。"
            "既存の工程と根拠は保ち、新しく分かった基準、分岐、根拠を足してください。"
            f"version は {base['version'] + 1} にし、source_runs に新しい仕込みを足してください。",
        ]
    else:
        parts += ["次の語りから工程データを作ってください。version は 1 です。"]
    parts += [format_run(name, rows) for name, rows in runs.items()]
    return "\n\n".join(parts)


def generate(prompt: str) -> dict:
    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=SYSTEM,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={
            "effort": "high",
            "format": {"type": "json_schema", "schema": output_schema()},
        },
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason != "end_turn":
        raise RuntimeError(f"生成が完了しませんでした: {message.stop_reason}")
    usage = message.usage
    cost = (usage.input_tokens * PRICE_PER_MTOK["input"] + usage.output_tokens * PRICE_PER_MTOK["output"]) / 1e6
    print(f"入力 {usage.input_tokens} / 出力 {usage.output_tokens} トークン（目安 ${cost:.2f}）")
    text = next(block.text for block in message.content if block.type == "text")
    return json.loads(text)


def run_folders(parent: Path) -> dict[str, Path]:
    folders = sorted(p for p in parent.iterdir() if p.is_dir())
    return {f"run{index}": folder for index, folder in enumerate(folders, start=1)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--runs", nargs="+", required=True)
    parser.add_argument("--base", type=Path)
    args = parser.parse_args()

    load_env()
    folders = run_folders(args.work)
    runs = {name: load_rows(folders[name]) for name in args.runs}
    base = json.loads(args.base.read_text(encoding="utf-8")) if args.base else None
    glossary = json.loads(GLOSSARY_PATH.read_text(encoding="utf-8"))
    corrections = json.loads(CORRECTIONS_PATH.read_text(encoding="utf-8"))

    rules = json.loads(CRAFT_RULES_PATH.read_text(encoding="utf-8"))

    data = generate(build_prompt(runs, base, glossary, corrections, rules))
    data.update(rules)
    draft = args.output.with_suffix(".draft.json")
    draft.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    validate_schema(data, json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))
    missing = check_evidence(data, {name: load_rows(folder) for name, folder in folders.items()})
    for item in missing:
        print("根拠が見つからない:", item)
    if missing:
        print(f"検査に通らなかったので {draft} に残しました")
        return 1
    draft.replace(args.output)
    print(f"{args.output}: 工程 {len(data['steps'])} 件（v{data['version']}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
