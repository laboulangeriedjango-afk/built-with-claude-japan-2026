"""audio.wav を文字起こしし、セグメントごとに transcript.jsonl へ追記する。

途中で止めても、再実行すると続きから処理する。
使い方: python transcribe.py <出力フォルダ> [--model small] [--vad-threshold 0.5] [--name transcript]
"""
import argparse
import json
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

SAMPLE_RATE = 16000
PROMPT = "パネットーネの本捏ね。ミキサー、生地、卵黄、バター、砂糖、グルテン、捏ね上げ、生地温度。"


def read_wav(path: Path, start: float) -> np.ndarray:
    """16kHz モノラルの WAV を start 秒以降だけ読む（PyAV のバージョン差を避けるため自前で読む）。"""
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1
        w.setpos(int(start * SAMPLE_RATE))
        pcm = w.readframes(w.getnframes() - w.tell())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(model: WhisperModel, folder: Path, name: str, vad_threshold: float) -> None:
    path = folder / f"{name}.jsonl"
    done = folder / f"{name}.done"
    if done.exists():
        return
    start = 0.0
    if path.exists():
        lines = path.read_text(encoding="utf-8").splitlines()
        if lines:
            start = json.loads(lines[-1])["end"]
    segments, _ = model.transcribe(
        read_wav(folder / "audio.wav", start),
        language="ja",
        initial_prompt=PROMPT,
        vad_filter=True,
        vad_parameters={"threshold": vad_threshold},
        condition_on_previous_text=False,
        word_timestamps=True,
    )
    with path.open("a", encoding="utf-8") as f:
        for s in segments:
            # セグメントの区間は無音を含んで長くなるため、実際に話した単語の時刻を使う
            begin, end = (s.words[0].start, s.words[-1].end) if s.words else (s.start, s.end)
            row = {
                "start": round(begin + start, 2),
                "end": round(end + start, 2),
                "text": s.text.strip(),
                "words": [
                    {"start": round(w.start + start, 2), "end": round(w.end + start, 2), "word": w.word}
                    for w in s.words or []
                ],
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            print(folder.name, row["start"], row["end"], row["text"], flush=True)
    done.touch()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--model", default="small")
    parser.add_argument("--vad-threshold", type=float, default=0.5, help="小さいほどミキサー音の中の声を拾う")
    parser.add_argument("--name", default="transcript", help="出力ファイル名")
    args = parser.parse_args()
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4)
    for folder in sorted(p for p in args.out.iterdir() if (p / "audio.wav").exists()):
        transcribe(model, folder, args.name, args.vad_threshold)


if __name__ == "__main__":
    main()
