// A が作った工程データを読み、版ごとの増分を確かめる画面。
import { formatClock } from "./guide.js";

const root = document.getElementById("root");
const KIND = { time: "時間", temperature: "温度", sight: "見て確認", touch: "手で確認" };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

async function loadVersions() {
  const versions = [];
  for (let n = 1; ; n += 1) {
    const response = await fetch(`../data/processed/versions/v${n}.json`);
    if (!response.ok) return versions;
    versions.push(await response.json());
  }
}

function whenLabel(when) {
  const range = [];
  if (when.dough_temp_min !== undefined) range.push(`${when.dough_temp_min}℃以上`);
  if (when.dough_temp_max !== undefined) range.push(`${when.dough_temp_max}℃以下`);
  return [...range, when.note].filter(Boolean).join("、");
}

function knownTexts(process) {
  const texts = new Set();
  for (const step of process?.steps ?? []) {
    for (const c of step.criteria) texts.add(c.text);
    for (const b of step.branches) texts.add(b.instruction);
  }
  return texts;
}

function evidenceList(evidence) {
  const lines = evidence.map(({ run, at_sec: sec, quote }) =>
    el("p", { textContent: `${run.replace("run", "")}回目 ${formatClock(sec * 1000)}「${quote}」` }));
  return el("details", {}, el("summary", { textContent: `根拠の発言 ${evidence.length}件` }), ...lines);
}

function item({ isNew, children }) {
  const badge = isNew ? el("span", { className: "badge", textContent: "この版で追加" }) : null;
  return el("div", { className: isNew ? "item new" : "item" }, badge, ...children);
}

function criterionItem(c, known) {
  return item({
    isNew: known !== null && !known.has(c.text),
    children: [
      el("p", {}, el("span", { className: "kind", textContent: `${KIND[c.kind]}　` }), c.text),
      c.visual_question ? el("p", { className: "question", textContent: `映像への質問：${c.visual_question}` }) : null,
      evidenceList(c.evidence),
    ],
  });
}

function branchItem(b, known) {
  return item({
    isNew: known !== null && !known.has(b.instruction),
    children: [
      el("p", { textContent: `${whenLabel(b.when)} → ${b.instruction}` }),
      evidenceList(b.evidence),
    ],
  });
}

function stepPanel(step, index, known) {
  const { min, max } = step.typical_minutes;
  return el("section", { className: "panel step" },
    el("h2", { textContent: `${index + 1}. ${step.title}` }),
    el("p", { className: "muted", textContent: `語りでの時間帯 ${min}〜${max}分${step.ask_dough_temp ? "　温度を入力" : ""}` }),
    el("p", { textContent: step.instruction }),
    el("h3", { textContent: "次へ進む基準" }),
    ...step.criteria.map((c) => criterionItem(c, known)),
    step.branches.length ? el("h3", { textContent: "状況に応じた判断" }) : null,
    ...step.branches.map((b) => branchItem(b, known)),
  );
}

function render(versions, index) {
  const process = versions[index];
  const known = index > 0 ? knownTexts(versions[index - 1]) : null;
  const steps = process.steps;
  const branchCount = steps.reduce((sum, s) => sum + s.branches.length, 0);
  const tabs = versions.map((v, i) => {
    const button = el("button", {
      textContent: `v${v.version}（${v.source_runs.length}回分）`,
      onclick: () => render(versions, i),
    });
    button.setAttribute("aria-pressed", String(i === index));
    return button;
  });
  root.replaceChildren(
    el("h1", { textContent: "語りから採集した工程" }),
    el("p", {
      className: "summary",
      textContent: `v${process.version}：${process.source_runs.length}回の仕込みから、工程 ${steps.length}件、判断 ${branchCount}件`,
    }),
    el("div", { className: "tabs" }, ...tabs),
    ...steps.map((step, i) => stepPanel(step, i, known)),
  );
}

loadVersions().then((versions) => {
  if (!versions.length) throw new Error("工程データが見つかりません");
  render(versions, versions.length - 1);
}).catch((error) => {
  root.replaceChildren(el("p", { textContent: error.message }));
});
