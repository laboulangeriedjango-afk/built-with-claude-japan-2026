import {
  advance,
  back,
  createSession,
  currentStep,
  elapsedMinutes,
  formatClock,
  isFinished,
  latestTemp,
  matchingTempBranches,
  recordTemp,
  situationalBranches,
  timing,
} from "./guide.js";

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

function setSession(next, { announce = false } = {}) {
  session = next;
  save();
  render();
  if (announce && session) speak(currentStep(process, session).instruction);
}

function renderStart() {
  root.replaceChildren(
    el("h1", { textContent: "パネットーネの本捏ね" }),
    el("p", {
      className: "instruction",
      textContent: `${process.source_runs.length}回の仕込みの語りをもとに、次にすることを案内します。`,
    }),
    el("div", { className: "actions" }, el("button", {
      className: "primary",
      textContent: "本捏ねを始める",
      onclick: () => {
        keepScreenOn();
        setSession(createSession(process, Date.now()), { announce: true });
      },
    })),
  );
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
    if (branch) speak(branch.instruction);
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
    ...alerts.map((b) => el("section", { className: "panel alert" },
      el("p", { textContent: b.instruction }), ...b.evidence.map(sourceLine))),
    step.ask_dough_temp ? tempPanel(step) : null,
    el("section", { className: "panel" },
      el("h2", { textContent: "次へ進む基準" }),
      el("ul", { className: "criteria" }, ...step.criteria.map((c) =>
        el("li", {}, el("p", { textContent: c.text }), ...c.evidence.map(sourceLine)))),
    ),
    notes.length ? el("section", { className: "panel" },
      el("h2", { textContent: "こんなときは" }),
      el("ul", { className: "notes" }, ...notes.map((b) =>
        el("li", {}, el("p", { textContent: `${b.when.note}：${b.instruction}` }), ...b.evidence.map(sourceLine)))),
    ) : null,
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
