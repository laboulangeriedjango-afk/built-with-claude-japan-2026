import {
  advance,
  back,
  createSession,
  currentStep,
  elapsedMinutes,
  finishDifference,
  formatClock,
  isFinished,
  isOverLimit,
  latestTemp,
  matchingTempBranches,
  recordTemp,
  situationalBranches,
  timing,
} from "./guide.js";
import { checkCriterion, clearKey, isCameraOn, loadKey, saveKey, startCamera, stopCamera } from "./camera.js";
import { sightCriteria } from "./vision.js";

const STORAGE_KEY = "hongone-session";
const root = document.getElementById("root");
const TIMING_LABEL = {
  early: "語りの時間帯より早めです",
  typical: "語りの時間帯の中です",
  late: "語りの時間帯より遅めです",
};

let process;
let session = null;
let wakeLock = null;
const CHECK_INTERVAL_MS = 30000;
const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, className: "preview" });
const vision = { results: new Map(), message: "", busy: false, cursor: 0, timer: null };

function save() {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できなくても案内は続ける
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && saved.version === process.version ? saved : null;
  } catch {
    return null;
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  speechSynthesis.speak(utterance);
}

async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

function sourceLine(evidence) {
  const { run, at_sec: sec, quote } = evidence;
  const label = run.replace("run", "") + "回目 " + formatClock(sec * 1000);
  return el("p", { className: "source", textContent: `${label}「${quote}」` });
}

function evidenceDetails(evidence) {
  return el("details", { className: "source" },
    el("summary", { textContent: `根拠の発言 ${evidence.length}件` }), ...evidence.map(sourceLine));
}

function principlesPanel() {
  if (!process.principles?.length) return null;
  return el("details", { className: "panel principles" },
    el("summary", { textContent: "全体の決まり" }),
    el("ul", { className: "notes" }, ...process.principles.map((text) => el("li", { textContent: text }))));
}

function limitAlert() {
  const text = `生地の温度は${process.limits.dough_temp_below - 1}度台までに抑えます。これ以上上げないようにしてください。`;
  return { text, node: el("section", { className: "panel alert" }, el("p", { textContent: text })) };
}

function finishLine(temp) {
  const diff = finishDifference(process, temp);
  if (diff === null) return null;
  const sign = diff > 0 ? "+" : "";
  const target = process.limits.finish_temp_target;
  return el("p", { className: "muted", textContent: `捏ね上げの目標 ${target}℃との差：${sign}${diff}℃` });
}

const STATUS_LABEL = { met: "基準に届いています", not_yet: "まだです", unclear: "判断できません" };

async function runCheck() {
  if (vision.busy || !session || !isCameraOn()) return;
  const step = currentStep(process, session);
  const criteria = sightCriteria(step);
  if (!criteria.length) return;
  const criterion = criteria[vision.cursor % criteria.length];
  vision.cursor += 1;
  vision.busy = true;
  vision.message = "確認しています…";
  render();
  try {
    const result = await checkCriterion(video, step.title, criterion);
    vision.message = "";
    if (session && currentStep(process, session).id === step.id) {
      const before = vision.results.get(criterion.text)?.status;
      vision.results.set(criterion.text, result);
      if (result.status === "met" && before !== "met") speak(result.note);
    }
  } catch (error) {
    vision.message = error.status === 401 ? "API キーを確認してください" : `確認できませんでした：${error.message}`;
  } finally {
    vision.busy = false;
    if (session) render();
  }
}

async function toggleCamera() {
  if (isCameraOn()) {
    stopCamera(video);
    clearInterval(vision.timer);
    vision.message = "";
    render();
    return;
  }
  try {
    await startCamera(video);
    vision.timer = setInterval(runCheck, CHECK_INTERVAL_MS);
    runCheck();
  } catch (error) {
    vision.message = `カメラを使えません：${error.message}`;
    render();
  }
}

function keyForm() {
  const input = el("input", { type: "password", placeholder: "API キー", autocomplete: "off" });
  input.setAttribute("aria-label", "Claude API キー");
  return el("div", {},
    el("p", { className: "muted", textContent: "カメラで確かめるには API キーが必要です。キーはこの端末にだけ保存します。カメラなしでも案内は使えます。" }),
    el("div", { className: "temp-row" }, input, el("button", {
      textContent: "保存",
      onclick: () => {
        if (input.value.trim() && saveKey(input.value)) render();
      },
    })),
  );
}

function cameraPanel(step) {
  const criteria = sightCriteria(step);
  if (!criteria.length) return null;
  if (!loadKey()) return el("section", { className: "panel" }, el("h2", { textContent: "カメラで確かめる" }), keyForm());
  const on = isCameraOn();
  return el("section", { className: "panel" },
    el("h2", { textContent: "カメラで確かめる" }),
    el("p", { className: "muted", textContent: "結果は参考です。回転中の映像では、艶や滑らかさを見誤ることがあります。最後は手と目で確かめてください。" }),
    on ? video : null,
    vision.message ? el("p", { className: "muted", textContent: vision.message }) : null,
    el("ul", { className: "criteria" }, ...criteria.map((c) => {
      const result = vision.results.get(c.text);
      return el("li", {},
        el("p", { textContent: c.visual_question }),
        result ? el("p", { className: `verdict ${result.status}`, textContent: `${STATUS_LABEL[result.status]}：${result.note}` }) : null);
    })),
    el("div", { className: "temp-row camera-actions" },
      el("button", { textContent: on ? "カメラを止める" : "カメラを開始", onclick: toggleCamera }),
      on ? el("button", { textContent: "今すぐ確認", disabled: vision.busy, onclick: runCheck }) : null,
      on ? null : el("button", { textContent: "キーを消す", onclick: () => { clearKey(); render(); } })),
  );
}

function setSession(next, { announce = false } = {}) {
  if (next?.stepIndex !== session?.stepIndex) {
    vision.results.clear();
    vision.cursor = 0;
  }
  if (!next && isCameraOn()) {
    stopCamera(video);
    clearInterval(vision.timer);
  }
  session = next;
  save();
  render();
  if (announce && session) speak(currentStep(process, session).instruction);
}

function renderStart() {
  const sections = [
    el("h1", { textContent: "パネットーネの本捏ね" }),
    el("p", {
      className: "instruction",
      textContent: `${process.source_runs.length}回の仕込みの語りをもとに、次にすることを案内します。`,
    }),
    principlesPanel(),
    el("div", { className: "actions" }, el("button", {
      className: "primary",
      textContent: "本捏ねを始める",
      onclick: () => {
        keepScreenOn();
        setSession(createSession(process, Date.now()), { announce: true });
      },
    })),
  ];
  root.replaceChildren(...sections.filter((section) => section !== null));
}

function tempPanel(step) {
  const value = latestTemp(session, step.id);
  const input = el("input", {
    type: "number",
    step: "0.1",
    inputMode: "decimal",
    placeholder: "例 25.5",
    value: value ?? "",
  });
  input.setAttribute("aria-label", "生地温度（℃）");
  const submit = () => {
    const temp = Number.parseFloat(input.value);
    if (Number.isNaN(temp)) return;
    setSession(recordTemp(session, step.id, temp, Date.now()));
    const [branch] = matchingTempBranches(step, temp);
    if (isOverLimit(process, temp)) speak(limitAlert().text);
    else if (branch) speak(branch.instruction);
  };
  return el("section", { className: "panel" },
    el("h2", { textContent: "生地温度（℃）" }),
    el("div", { className: "temp-row" }, input, el("button", { textContent: "記録", onclick: submit })),
  );
}

function renderStep() {
  const step = currentStep(process, session);
  const temp = latestTemp(session, step.id);
  const alerts = matchingTempBranches(step, temp);
  const notes = situationalBranches(step);
  const minutes = elapsedMinutes(session, Date.now());

  const sections = [
    el("div", { className: "topbar" },
      el("span", { className: "muted", textContent: `工程 ${session.stepIndex + 1} / ${process.steps.length}` }),
      el("span", { className: "clock", id: "clock", textContent: formatClock(Date.now() - session.startedAt) }),
    ),
    el("h1", { textContent: step.title }),
    el("p", { className: "instruction", textContent: step.instruction }),
    el("p", {
      className: "muted",
      id: "timing",
      textContent: `目安 ${step.typical_minutes.min}〜${step.typical_minutes.max}分。${TIMING_LABEL[timing(step, minutes)]}`,
    }),
    isOverLimit(process, temp) ? limitAlert().node : null,
    isFinished(process, session) ? finishLine(temp) : null,
    ...alerts.map((b) => el("section", { className: "panel alert" },
      el("p", { textContent: b.instruction }), ...b.evidence.map(sourceLine))),
    step.ask_dough_temp ? tempPanel(step) : null,
    cameraPanel(step),
    el("section", { className: "panel" },
      el("h2", { textContent: "次へ進む基準" }),
      el("ul", { className: "criteria" }, ...step.criteria.map((c) =>
        el("li", {}, el("p", { textContent: c.text }), evidenceDetails(c.evidence)))),
    ),
    notes.length ? el("section", { className: "panel" },
      el("h2", { textContent: "こんなときは" }),
      el("ul", { className: "notes" }, ...notes.map((b) =>
        el("li", {}, el("p", { textContent: `${b.when.note}：${b.instruction}` }), evidenceDetails(b.evidence)))),
    ) : null,
    principlesPanel(),
    el("div", { className: "actions" },
      el("button", { textContent: "戻る", onclick: () => setSession(back(session, Date.now())) }),
      el("button", { textContent: "読み上げ", onclick: () => speak(step.instruction) }),
      isFinished(process, session)
        ? el("button", { className: "primary", textContent: "終了", onclick: () => setSession(null) })
        : el("button", {
          className: "primary",
          textContent: "次へ",
          onclick: () => setSession(advance(process, session, Date.now()), { announce: true }),
        }),
    ),
  ];
  root.replaceChildren(...sections.filter((section) => section !== null));
}

function render() {
  if (session) renderStep();
  else renderStart();
}

function tick() {
  if (!session) return;
  const clock = document.getElementById("clock");
  if (clock) clock.textContent = formatClock(Date.now() - session.startedAt);
  const line = document.getElementById("timing");
  if (line) {
    const step = currentStep(process, session);
    const state = timing(step, elapsedMinutes(session, Date.now()));
    line.textContent = `目安 ${step.typical_minutes.min}〜${step.typical_minutes.max}分。${TIMING_LABEL[state]}`;
  }
}

async function main() {
  const response = await fetch("../data/processed/process.json");
  if (!response.ok) throw new Error(`工程データを読めません: ${response.status}`);
  process = await response.json();
  session = restore();
  render();
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (session && document.visibilityState === "visible") keepScreenOn();
  });
}

main().catch((error) => {
  root.replaceChildren(el("p", { className: "alert", textContent: error.message }));
});
