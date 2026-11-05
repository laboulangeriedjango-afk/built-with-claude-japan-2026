import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  advance,
  back,
  createSession,
  currentStep,
  formatClock,
  isFinished,
  latestTemp,
  matchingTempBranches,
  recordTemp,
  situationalBranches,
  timing,
} from "./guide.js";

const url = new URL("./fixtures/process.json", import.meta.url);
const process = JSON.parse(readFileSync(url, "utf-8"));
const step = (id) => process.steps.find((s) => s.id === id);

test("最後の工程より先へは進まない", () => {
  let session = createSession(process, 0);
  for (let i = 0; i < process.steps.length + 3; i += 1) session = advance(process, session, i);
  assert.equal(currentStep(process, session).id, "finish");
  assert.equal(isFinished(process, session), true);
});

test("最初の工程より前へは戻らない", () => {
  const session = createSession(process, 0);
  assert.equal(back(session, 1).stepIndex, 0);
});

test("26.6℃以上で冷水の分岐が出て、26.5℃では出ない", () => {
  assert.equal(matchingTempBranches(step("adjust"), 26.6).length, 1);
  assert.equal(matchingTempBranches(step("adjust"), 26.5).length, 0);
});

test("25℃以下で強めに混ぜる分岐が出る", () => {
  assert.equal(matchingTempBranches(step("absorb"), 24.9).length, 1);
  assert.equal(matchingTempBranches(step("absorb"), 25.1).length, 0);
});

test("温度が未入力なら温度の分岐は出ない", () => {
  assert.deepEqual(matchingTempBranches(step("adjust"), null), []);
});

test("状況の分岐は温度の分岐と混ざらない", () => {
  const notes = situationalBranches(step("absorb"));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].when.note, "フックに生地がかかりにくいとき");
});

test("同じ工程の温度は最新の値を使う", () => {
  let session = createSession(process, 0);
  session = recordTemp(session, "adjust", 25, 1);
  session = recordTemp(session, "adjust", 27, 2);
  assert.equal(latestTemp(session, "adjust"), 27);
  assert.equal(latestTemp(session, "absorb"), null);
});

test("語りの時間帯と比べて早い・遅いを判定する", () => {
  const s = step("fruit");
  assert.equal(timing(s, 30), "early");
  assert.equal(timing(s, 40), "typical");
  assert.equal(timing(s, 50), "late");
});

test("経過時間を分と秒で表示する", () => {
  assert.equal(formatClock(125000), "02:05");
});
