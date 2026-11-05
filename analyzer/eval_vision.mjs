// 参考映像に使っていない仕込みのコマで、映像の確認が見分けられるかを測る。
// 使い方: node analyzer/eval_vision.mjs <4回目の frames フォルダ>
// 検証するのは、find_stops.py で見つけたミキサーが止まっている場面。
// 正解は、4回目の語りの時刻から付けた仮のもの。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "../app/vendor/anthropic-sdk.js";
import { buildVisionRequest, readVisionResponse, sightCriteria } from "../app/vision.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const processed = join(root, "data", "processed");
const process_ = JSON.parse(readFileSync(join(processed, "process.json"), "utf-8"));
const env = readFileSync(join(root, ".env"), "utf-8").replace(/^﻿/, "");
const apiKey = env.match(/ANTHROPIC_API_KEY=(.+)/)[1].trim();
const client = new Anthropic({ apiKey });

const CASES = [
  { step: "step2", match: "表面", frame: 179, expected: "not_yet", why: "14:50 まだ次へ進まない時点" },
  { step: "step2", match: "表面", frame: 218, expected: "met", why: "18:05 次へ進むと発言した直後" },
  { step: "step5", match: "塊", frame: 305, expected: "not_yet", why: "25:20 バターの粒が見える" },
  { step: "step5", match: "粗さ", frame: 305, expected: "not_yet", why: "25:20 バターを入れている最中" },
  { step: "step5", match: "粗さ", frame: 448, expected: "met", why: "37:15 引っ張るとついてくると発言" },
  { step: "step6", match: "フルーツ", frame: 448, expected: "not_yet", why: "37:15 フルーツを入れた直後" },
  { step: "step6", match: "フルーツ", frame: 468, expected: "met", why: "38:50 捏ね上げの直前" },
];

const framesDir = process.argv[2];
const b64 = (path) => readFileSync(path).toString("base64");

let hits = 0;
let unclear = 0;
for (const item of CASES) {
  const step = process_.steps.find((s) => s.id === item.step);
  const criterion = sightCriteria(step).find((c) => c.visual_question.includes(item.match) || c.text.includes(item.match));
  const references = (criterion.reference_frames ?? []).map((r) => ({ ...r, data: b64(join(processed, r.path)) }));
  const request = buildVisionRequest({
    stepTitle: step.title,
    criterion,
    references,
    currentImages: [b64(join(framesDir, `${String(item.frame).padStart(5, "0")}.jpg`))],
    stopped: true,
  });
  const started = Date.now();
  const result = readVisionResponse(await client.beta.messages.create(request));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === item.expected;
  if (ok) hits += 1;
  if (result.status === "unclear") unclear += 1;
  console.log(`${ok ? "○" : "×"} ${item.step}（${item.why}）期待=${item.expected} 結果=${result.status} ${seconds}秒「${result.note}」`);
}
console.log(`一致 ${hits}/${CASES.length}、判断不能 ${unclear}`);
