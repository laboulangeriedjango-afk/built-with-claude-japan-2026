// スマホのカメラで今の映像を撮り、Claude に基準を確かめてもらう。
import Anthropic from "./vendor/anthropic-sdk.js";
import { buildVisionRequest, readVisionResponse, sharpness } from "./vision.js";

const KEY_STORAGE = "hongone-api-key";
const FRAME_SIZE = 512;
const BURST = 6;
const BURST_GAP_MS = 500;
const SEND_FRAMES = 3;

const referenceCache = new Map();
let stream = null;

export function loadKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveKey(key) {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
    return true;
  } catch {
    return false;
  }
}

export function clearKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // 消せない環境でも案内は続ける
  }
}

export async function startCamera(video) {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

export function stopCamera(video) {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

export function isCameraOn() {
  return stream !== null;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function grabFrame(video, canvas, context) {
  const side = Math.min(video.videoWidth, video.videoHeight);
  const left = (video.videoWidth - side) / 2;
  const top = (video.videoHeight - side) / 2;
  context.drawImage(video, left, top, side, side, 0, 0, FRAME_SIZE, FRAME_SIZE);
  const { data } = context.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE);
  const gray = new Float32Array(FRAME_SIZE * FRAME_SIZE);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return { score: sharpness(gray, FRAME_SIZE, FRAME_SIZE), jpeg: canvas.toDataURL("image/jpeg", 0.8) };
}

// 回転中はぶれるので、連続で撮って鮮明な数枚を使う。
async function captureSharpest(video) {
  const canvas = Object.assign(document.createElement("canvas"), { width: FRAME_SIZE, height: FRAME_SIZE });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < BURST; i += 1) {
    frames.push(grabFrame(video, canvas, context));
    await wait(BURST_GAP_MS);
  }
  frames.sort((a, b) => b.score - a.score);
  return frames.slice(0, SEND_FRAMES).map((frame) => frame.jpeg.split(",")[1]);
}

async function loadReference(reference) {
  if (referenceCache.has(reference.path)) return referenceCache.get(reference.path);
  const response = await fetch(`../data/processed/${reference.path}`);
  const blob = await response.blob();
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const loaded = { ...reference, data };
  referenceCache.set(reference.path, loaded);
  return loaded;
}

export async function checkCriterion(video, stepTitle, criterion, stopped) {
  const client = new Anthropic({ apiKey: loadKey(), dangerouslyAllowBrowser: true });
  const [currentImages, references] = await Promise.all([
    captureSharpest(video),
    Promise.all((criterion.reference_frames ?? []).map(loadReference)),
  ]);
  const request = buildVisionRequest({ stepTitle, criterion, references, currentImages, stopped });
  return readVisionResponse(await client.beta.messages.create(request));
}
