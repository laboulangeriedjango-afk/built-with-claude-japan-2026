import {
  advance,
  back,
  createSession,
  currentStep,
  finishDifference,
  formatClock,
  isFinished,
  isOverLimit,
  latestTemp,
  matchingTempBranches,
  needsRescue,
  recordTemp,
  situationalBranches,
  stepMinutes,
  timing,
} from "./guide.js";
import { checkCriterion, clearKey, isCameraOn, loadKey, saveKey, startCamera, stopCamera } from "./camera.js";
import { sightCriteria } from "./vision.js";

const STORAGE_KEY = "hongone-session";
const root = document.getElementById("root");
const TIMING_LABEL = {
  early: "まだ目安の前です",
  typical: "目安の時間です",
  late: "目安を過ぎています",
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
  if (!evidence.length) return el("p", { className: "source", textContent: "職人の確認による内容" });
  return el("details", { className: "source" },
    el("summary", { textContent: `根拠の発言 ${evidence.length}件` }), ...evidence.map(sourceLine));
}

function principlesPanel() {
  if (!process.principles?.length) return null;
  return el("details", { className: "panel principles" },
    el("summary", { textContent: "全体の決まり" }),
    el("ul", { className: "notes" }, ...process.principles.map((text) => el("li", { textContent: text }))));
}

function rescuePanel() {
  const { cause, actions } = process.rescue;
  return el("section", { className: "panel alert rescue" },
    el("h2", { textContent: "生地温度が高くなっています" }),
    el("ol", { className: "rescue-actions" }, ...actions.map((action) =>
      el("li", {}, action.last_resort ? el("strong", { textContent: "最後の手段　" }) : null, action.text))),
    el("details", { className: "source" }, el("summary", { textContent: "なぜ温度が問題なのか" }), el("p", { textContent: cause })));
}

function signsPanel() {
  if (!process.rescue) return null;
  const { signs, sign_action: action } = process.rescue;
  return el("section", { className: "panel" },
    el("h2", { textContent: "危険のサイン" }),
    el("ul", { className: "notes" }, ...signs.map((text) => el("li", { textContent: text }))),
    el("div", { className: "temp-row camera-actions" }, el("button", {
      textContent: "様子がおかしい",
      onclick: () => {
        speak(action);
        document.querySelector('input[type="number"]')?.focus();
      },
    })));
}

function limitAlert() {
  const text = `生地の温度は${process.limits.dough_temp_below - 1}度台までに抑えます。これ以上上げないようにしてください。`;
  return { text, node: el("section", { className: "panel alert" }, el("p", { textContent: text })) };
}

function timingText(step) {
  const { duration_minutes: range, time_note: note } = step;
  const parts = [];
  if (range) {
    const span = range.min === range.max ? `${range.min}分程度` : `${range.min}〜${range.max}分`;
    const elapsed = Date.now() - session.stepStartedAt;
    const state = TIMING_LABEL[timing(step, stepMinutes(session, Date.now()))];
    parts.push(`この工程 ${formatClock(elapsed)}／目安 ${span}。${state}。`);
  }
  if (note) parts.push(note);
  return parts.join("");
}

function finishLine(temp) {
  const diff = finishDifference(process, temp);
  if (diff === null) return null;
  const sign = diff > 0 ? "+" : "";
  const target = process.limits.finish_temp_target;
  return el("p", { className: "muted", textContent: `捏ね上げの目標 ${target}℃との差：${sign}${diff}℃` });
}

const STOP_DELAY_MS = 5000;

function verdictLabel({ status, stopped }) {
  if (status === "not_yet") return "まだです";
  if (status === "met") return stopped ? "基準に届いています" : "そろそろです。止めて確かめてください";
  return stopped ? "判断できません" : "回転中は見えません。止めて確かめてください";
}

async function runCheck({ stopped = false } = {}) {
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
    const result = { ...(await checkCriterion(video, step.title, criterion, stopped)), stopped };
    vision.message = "";
    if (session && currentStep(process, session).id === step.id) {
      const before = vision.results.get(criterion.text)?.status;
      vision.results.set(criterion.text, result);
      if (stopped) speak(`${verdictLabel(result)}。${result.note}`);
      else if (result.status === "met" && before !== "met") speak(verdictLabel(result));
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
    vision.timer = setInterval(() => runCheck(), CHECK_INTERVAL_MS);
    runCheck();
  } catch (error) {
    vision.message = `カメラを使えません：${error.message}`;
    render();
  }
}

async function stopAndCheck() {
  if (vision.busy) return;
  vision.busy = true;
  vision.message = "ミキサーを止めて、生地が見えるようにしてください";
  render();
  speak(vision.message);
  await new Promise((resolve) => {
    setTimeout(resolve, STOP_DELAY_MS);
  });
  vision.busy = false;
  await runCheck({ stopped: true });
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

function chefPanel(step) {
  const frames = sightCriteria(step).flatMap((c) =>
    (c.reference_frames ?? []).map((frame) => ({ ...frame, text: c.text })));
  if (!frames.length) return null;
  return el("section", { className: "panel" },
    el("h2", { textContent: "シェフの映像と見比べる" }),
    el("div", { className: "refs" }, ...frames.map(({ path, run, frame_sec: sec, state, text }) => {
      const label = `${state === "not_yet" ? "まだの例" : "届いた例"}　${run.replace("run", "")}回目 ${formatClock(sec * 1000)}`;
      return el("figure", {},
        el("img", { src: `../data/processed/${path}`, alt: `${label} ${text}`, loading: "lazy" }),
        el("figcaption", { textContent: `${label}：${text}` }));
    })));
}

function cameraPanel(step) {
  const criteria = sightCriteria(step);
  if (!criteria.length) return null;
  if (!loadKey()) return el("section", { className: "panel" }, el("h2", { textContent: "カメラで確かめる" }), keyForm());
  const on = isCameraOn();
  return el("section", { className: "panel" },
    el("h2", { textContent: "カメラで確かめる" }),
    el("p", { className: "muted", textContent: "回転中の確認は目安です。艶や滑らかさは、ミキサーを止めて確かめます。最後は手と目で判断してください。" }),
    on ? video : null,
    vision.message ? el("p", { className: "muted", textContent: vision.message }) : null,
    el("ul", { className: "criteria" }, ...criteria.map((c) => {
      const result = vision.results.get(c.text);
      return el("li", {},
        el("p", { textContent: c.visual_question }),
        result ? el("p", { className: `verdict ${result.status}`, textContent: `${verdictLabel(result)}：${result.note}` }) : null);
    })),
    el("div", { className: "temp-row camera-actions" },
      el("button", { textContent: on ? "カメラを止める" : "カメラを開始", onclick: toggleCamera }),
      on ? el("button", { className: "primary", textContent: "止めて確認", disabled: vision.busy, onclick: stopAndCheck }) : null,
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
    else if (needsRescue(process, temp)) speak("生地温度が高くなっています。対処を確認してください。");
    else if (branch) speak(branch.instruction);
  };
  return el("section", { className: "panel" },
    el("h2", { textContent: "生地温度（℃）" }),
    process.rescue ? el("p", { className: "muted", textContent: process.rescue.check_habit }) : null,
    el("div", { className: "temp-row" }, input, el("button", { textContent: "記録", onclick: submit })),
  );
}

function renderStep() {
  const step = currentStep(process, session);
  const temp = latestTemp(session, step.id);
  const alerts = matchingTempBranches(step, temp);
  const notes = situationalBranches(step);

  const sections = [
    el("div", { className: "topbar" },
      el("span", { className: "muted", textContent: `工程 ${session.stepIndex + 1} / ${process.steps.length}` }),
      el("span", { className: "clock", id: "clock", textContent: formatClock(Date.now() - session.startedAt) }),
    ),
    el("h1", { textContent: step.title }),
    el("p", { className: "instruction", textContent: step.instruction }),
    el("p", { className: "muted", id: "timing", textContent: timingText(step) }),
    isOverLimit(process, temp) ? limitAlert().node : null,
    needsRescue(process, temp) ? rescuePanel() : null,
    isFinished(process, session) ? finishLine(temp) : null,
    ...alerts.map((b) => el("section", { className: "panel alert" },
      el("p", { textContent: b.instruction }), ...b.evidence.map(sourceLine))),
    tempPanel(step),
    chefPanel(step),
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
    signsPanel(),
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
  if (line) line.textContent = timingText(currentStep(process, session));
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
