"""コマの動きと鮮明さから、ミキサーが止まっている区間を見つける。

止まっている間は連続するコマの差が小さく、映像がぶれない。
使い方: python find_stops.py <文字起こしの親フォルダ>
結果は各仕込みのフォルダの stops.json に書く。
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from build_refs import sharpness

FRAME_INTERVAL_SEC = 5
MOTION_THRESHOLD = 6.0
SHARP_RATIO = 1.5
MERGE_GAP_FRAMES = 1


def load_gray(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L").resize((128, 128)), dtype=np.float32)


def find_stops(frames_dir: Path) -> list[dict]:
    paths = sorted(frames_dir.glob("*.jpg"))
    grays = [load_gray(path) for path in paths]
    motion = [float(np.abs(a - b).mean()) for a, b in zip(grays, grays[1:])] + [99.0]
    sharp = [sharpness(path) for path in paths]
    baseline = float(np.median(sharp))
    still = [m < MOTION_THRESHOLD and s > baseline * SHARP_RATIO for m, s in zip(motion, sharp)]

    stops: list[dict] = []
    for index, is_still in enumerate(still):
        if not is_still:
            continue
        if stops and index - stops[-1]["last"] <= MERGE_GAP_FRAMES + 1:
            stops[-1]["last"] = index
        else:
            stops.append({"first": index, "last": index})
    result = []
    for stop in stops:
        best = max(range(stop["first"], stop["last"] + 1), key=lambda i: sharp[i])
        result.append({
            "start_sec": stop["first"] * FRAME_INTERVAL_SEC,
            "end_sec": stop["last"] * FRAME_INTERVAL_SEC,
            "best_frame": paths[best].name,
            "sharpness": round(sharp[best]),
        })
    return result


def main() -> None:
    for folder in sorted(p for p in Path(sys.argv[1]).iterdir() if p.is_dir()):
        stops = find_stops(folder / "frames")
        (folder / "stops.json").write_text(json.dumps(stops, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{folder.name}: {len(stops)} 区間")
        for stop in stops:
            start, end = stop["start_sec"], stop["end_sec"]
            print(f"  {start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d} {stop['best_frame']} 鮮明さ {stop['sharpness']}")


if __name__ == "__main__":
    main()
