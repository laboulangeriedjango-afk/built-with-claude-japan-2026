"""検証用に、アプリと同じ撮り方でコマを作る（0.3秒おきに4枚撮り、最も鮮明な1枚を残す）。

使い方: python eval_frames.py <動画> <出力フォルダ> <秒> [<秒> ...]
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg

from build_refs import sharpness

BURST = 4
GAP_SEC = 0.3


def burst(video: Path, at_sec: float, folder: Path) -> Path:
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(at_sec), "-i", str(video),
        "-vf", f"fps={1 / GAP_SEC},scale=512:-2", "-frames:v", str(BURST), "-q:v", "3",
        str(folder / "%02d.jpg"),
    ]
    subprocess.run(command, check=True)
    return max(folder.glob("*.jpg"), key=sharpness)


def main() -> None:
    video, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for value in sys.argv[3:]:
        with tempfile.TemporaryDirectory() as temp:
            best = burst(video, float(value), Path(temp))
            (out / f"{value}.jpg").write_bytes(best.read_bytes())
        print(value, flush=True)


if __name__ == "__main__":
    main()
