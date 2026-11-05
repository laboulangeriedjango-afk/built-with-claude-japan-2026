"""動画から音声（16kHz モノラル）とコマ画像（低解像度）を取り出す。

非力な PC でも動くよう、映像はキーフレームだけをデコードする。
使い方: python extract.py <動画フォルダ> <出力フォルダ> [--interval 秒]
"""
import argparse
import subprocess
from pathlib import Path

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def run(args: list[str]) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def extract(video: Path, out: Path, interval: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    audio = out / "audio.wav"
    if not audio.exists():
        run(["-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(audio)])
    frames = out / "frames"
    if not frames.exists():
        frames.mkdir()
        run([
            "-skip_frame", "nokey", "-i", str(video), "-an",
            "-vf", f"fps=1/{interval},scale=512:-2",
            "-q:v", "5", str(frames / "%05d.jpg"),
        ])
    print(f"{video.name}: {len(list(frames.glob('*.jpg')))} コマ")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("videos", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--interval", type=int, default=5, help="コマの間隔（秒）")
    args = parser.parse_args()
    for video in sorted(args.videos.glob("*.mp4")):
        extract(video, args.out / video.stem, args.interval)


if __name__ == "__main__":
    main()
