// 本捏ねの進行を管理する。画面に依存しないので Node でもテストできる。

export function createSession(process, now) {
  return { startedAt: now, stepIndex: 0, stepStartedAt: now, temps: [], version: process.version };
}

export function currentStep(process, session) {
  return process.steps[session.stepIndex];
}

export function isFinished(process, session) {
  return session.stepIndex >= process.steps.length - 1;
}

export function advance(process, session, now) {
  if (isFinished(process, session)) return session;
  return { ...session, stepIndex: session.stepIndex + 1, stepStartedAt: now };
}

export function back(session, now) {
  if (session.stepIndex === 0) return session;
  return { ...session, stepIndex: session.stepIndex - 1, stepStartedAt: now };
}

export function recordTemp(session, stepId, value, now) {
  return { ...session, temps: [...session.temps, { stepId, value, at: now }] };
}

export function latestTemp(session, stepId) {
  const temps = session.temps.filter((t) => t.stepId === stepId);
  return temps.length ? temps[temps.length - 1].value : null;
}

// 温度で判断できる分岐だけを返す。状況の説明だけの分岐は situationalBranches で見せる。
export function matchingTempBranches(step, temp) {
  if (temp === null) return [];
  return step.branches.filter(({ when }) => {
    const hasRange = when.dough_temp_min !== undefined || when.dough_temp_max !== undefined;
    if (!hasRange) return false;
    if (when.dough_temp_min !== undefined && temp < when.dough_temp_min) return false;
    if (when.dough_temp_max !== undefined && temp > when.dough_temp_max) return false;
    return true;
  });
}

export function situationalBranches(step) {
  return step.branches.filter(
    ({ when }) => when.dough_temp_min === undefined && when.dough_temp_max === undefined,
  );
}

export function elapsedMinutes(session, now) {
  return (now - session.startedAt) / 60000;
}

// 語りから得た時間帯と比べた現在の位置。
export function timing(step, minutes) {
  const { min, max } = step.typical_minutes;
  if (minutes < min) return "early";
  if (minutes > max) return "late";
  return "typical";
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
