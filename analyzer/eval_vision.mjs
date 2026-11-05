// 参考映像に使っていない仕込みのコマで、映像の確認が見分けられるかを測る。
// 使い方: node analyzer/eval_vision.mjs <eval_frames.py の出力フォルダ>
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
  { step: "step2", match: "表面", sec: 120, expected: "not_yet", why: "粉を入れた直後" },
  { step: "step2", match: "表面", sec: 1050, expected: "met", why: "次の工程へ進む直前" },
  { step: "step5", match: "塊", sec: 1500, expected: "not_yet", why: "バターを入れている最中" },
  { step: "step5", match: "塊", sec: 1640, expected: "met", why: "大きな塊はもうないと発言" },
  { step: "step6", match: "粗さ", sec: 1700, expected: "not_yet", why: "混ぜ始め" },
  { step: "step6", match: "粗さ", sec: 2190, expected: "met", why: "そろそろ終わりにすると発言" },
  { step: "step7", match: "フルーツ", sec: 2225, expected: "not_yet", why: "フルーツを入れた直後" },
  { step: "step7", match: "フルーツ", sec: 2300, expected: "met", why: "フルーツを入れて約1分半後" },
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
    currentImages: [0, 1, 2].map((i) => b64(join(framesDir, `${item.sec}_${i}.jpg`))),
  });
  const started = Date.now();
  const result = readVisionResponse(await client.beta.messages.create(request));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === item.expected;
  if (ok) hits += 1;
  if (result.status === "unclear") unclear += 1;
  console.log(`${ok ? "○" : "×"} ${item.step} ${item.sec}秒（${item.why}）期待=${item.expected} 結果=${result.status} ${seconds}秒「${result.note}」`);
}
console.log(`一致 ${hits}/${CASES.length}、判断不能 ${unclear}`);
