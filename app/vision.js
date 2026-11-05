// 語りから得た基準に、今の生地が届いたかを確かめる。画面に依存しないので Node でも使える。

export const VISION_MODEL = "claude-opus-5-5";
export const VISION_BETAS = ["server-side-fallback-2026-07-01"];

const STATUS = ["met", "not_yet", "unclear"];

const SYSTEM = `あなたはパネットーネの本捏ねで、職人の基準に生地が届いたかを確かめる係です。
「今の映像」は、今のミキサーを数秒の間に撮った複数の画像です。参考映像は、同じカメラ位置で撮った職人自身の仕込みの映像です。

守ること:
- 与えられた基準の質問だけに答える。一般的な製パン知識で判断を広げない
- 参考映像と職人の言葉を手がかりに、今の映像を比べる
- 回転中で映像はぶれる。複数の画像を合わせて、細部ではなく全体の色、形、まとまり方、ボウルへの付き方で判断する
- 全体の様子でも判断できないとき、または手や物で生地が隠れているときだけ unclear にする
- 届いていれば met、まだなら not_yet にする
- note は作業者に読み上げる30字以内の一文にする。見えた事実だけを書く`;

export const VISION_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUS },
      note: { type: "string" },
    },
    required: ["status", "note"],
    additionalProperties: false,
  },
};

function imageBlock(data) {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

export function buildVisionRequest({ stepTitle, criterion, references, currentImages }) {
  const content = [];
  references.forEach(({ data, run, quote }) => {
    content.push({ type: "text", text: `参考映像（${run.replace("run", "")}回目。職人の言葉「${quote}」）` });
    content.push(imageBlock(data));
  });
  content.push({ type: "text", text: "今の映像" });
  currentImages.forEach((data) => content.push(imageBlock(data)));
  content.push({
    type: "text",
    text: `工程：${stepTitle}\n職人の基準：${criterion.text}\n質問：${criterion.visual_question}`,
  });
  return {
    model: VISION_MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    betas: VISION_BETAS,
    fallbacks: "default",
    output_config: { effort: "low", format: VISION_FORMAT },
    messages: [{ role: "user", content }],
  };
}

export function readVisionResponse(message) {
  if (message.stop_reason !== "end_turn") return { status: "unclear", note: "確認できませんでした" };
  const block = message.content.find((item) => item.type === "text");
  const result = JSON.parse(block.text);
  return STATUS.includes(result.status) ? result : { status: "unclear", note: "確認できませんでした" };
}

// グレースケールの輝度配列から、鮮明さ（ラプラシアンの分散）を求める。
export function sharpness(gray, width, height) {
  let sum = 0;
  let squared = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += value;
      squared += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return squared / count - mean * mean;
}

export function sightCriteria(step) {
  return step.criteria.filter((c) => c.kind === "sight");
}
