"""audio.wav を文字起こしし、セグメントごとに transcript.jsonl へ追記する。

途中で止めても、再実行すると続きから処理する。
使い方: python transcribe.py <出力フォルダ> [--model small]
"""
import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel

PROMPT = "パネットーネの本捏ね。ミキサー、生地、卵黄、バター、砂糖、グルテン、捏ね上げ、生地温度。"


def transcribe(model: WhisperModel, folder: Path) -> None:
    path = folder / "transcript.jsonl"
    done = folder / "transcript.done"
    if done.exists():
        return
    start = 0.0
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
        if lines:
            start = json.loads(lines[-1])["end"]
    segments, _ = model.transcribe(
        str(folder / "audio.wav"),
        language="ja",
        initial_prompt=PROMPT,
        vad_filter=True,
        condition_on_previous_text=False,
        clip_timestamps=[start],
    )
    with path.open("a", encoding="utf-8") as f:
        for s in segments:
            row = {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            print(folder.name, row, flush=True)
    done.touch()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--model", default="small")
    args = parser.parse_args()
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4)
    for folder in sorted(p for p in args.out.iterdir() if (p / "audio.wav").exists()):
        transcribe(model, folder)


if __name__ == "__main__":
    main()
