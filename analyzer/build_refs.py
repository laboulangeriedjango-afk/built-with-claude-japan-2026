"""見て確認する基準に、語りの時点の映像を参考として付ける。

回転中の映像はぶれるので、発言の前後から最も鮮明なコマを選ぶ。
使い方: python build_refs.py <工程データ> <文字起こしの親フォルダ> --hold-out run4
--hold-out の仕込みは精度の検証に使うので、参考映像に含めない。
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

FRAME_INTERVAL_SEC = 5
SEARCH_FRAMES = 2
MAX_REFERENCES = 2


def sharpness(path: Path) -> float:
    gray = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
    laplacian = (
        gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4 * gray[1:-1, 1:-1]
    )
    return float(laplacian.var())


def sharpest_frame(frames: Path, at_sec: float) -> Path | None:
    center = round(at_sec / FRAME_INTERVAL_SEC) + 1
    candidates = [frames / f"{n:05d}.jpg" for n in range(center - SEARCH_FRAMES, center + SEARCH_FRAMES + 1)]
    existing = [path for path in candidates if path.exists()]
    return max(existing, key=sharpness) if existing else None


def choose_evidence(evidence: list[dict], hold_out: set[str]) -> list[dict]:
    """なるべく別々の仕込みから選ぶ。"""
    usable = [item for item in evidence if item["run"] not in hold_out]
    chosen: list[dict] = []
    for item in usable:
        if item["run"] not in {c["run"] for c in chosen}:
            chosen.append(item)
    for item in usable:
        if item not in chosen:
            chosen.append(item)
    return chosen[:MAX_REFERENCES]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("process", type=Path)
    parser.add_argument("work", type=Path)
    parser.add_argument("--hold-out", nargs="*", default=[])
    args = parser.parse_args()

    data = json.loads(args.process.read_text(encoding="utf-8"))
    folders = sorted(p for p in args.work.iterdir() if p.is_dir())
    runs = {f"run{i}": folder for i, folder in enumerate(folders, start=1)}
    refs_dir = args.process.parent / "refs"
    refs_dir.mkdir(exist_ok=True)

    count = 0
    for step in data["steps"]:
        for criterion in step["criteria"]:
            if criterion["kind"] != "sight":
                continue
            references = []
            for item in choose_evidence(criterion["evidence"], set(args.hold_out)):
                frame = sharpest_frame(runs[item["run"]] / "frames", item["at_sec"])
                if frame is None:
                    continue
                name = f"{item['run']}_{round(item['at_sec'])}.jpg"
                (refs_dir / name).write_bytes(frame.read_bytes())
                references.append({
                    "path": f"refs/{name}",
                    "run": item["run"],
                    "at_sec": item["at_sec"],
                    "quote": item["quote"],
                })
                count += 1
            criterion["reference_frames"] = references
    args.process.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"参考映像 {count} 件")


if __name__ == "__main__":
    main()
