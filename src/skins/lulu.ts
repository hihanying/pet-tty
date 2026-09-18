/**
 * 噜噜（lulu-capybara）—— 内置默认桌宠。
 * 素材：水豚角色「噜噜」（用户提供的 spritesheet.webp + pet.json），
 * 已按 192x208 网格切分为逐状态 PNG 序列帧，
 * 构建时经 Vite 以资源 URL 注入（非 data URL，避免内联膨胀）。
 * 行 → 状态映射：站立=待机、走路=调用工具、反向走=跑测试、招手=等确认、
 * 欢呼=成功、哭泣=出错、张望=思考、端坐=编辑。
 */
import type { SkinMeta, SpriteFrame, SpriteManifest } from "./types";

const frameUrls = import.meta.glob("./assets/lulu/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function framesFor(state: string): SpriteFrame[] {
  return Object.keys(frameUrls)
    .filter((p) => p.includes(`/lulu/${state}/`))
    .sort()
    .map((p) => ({ src: frameUrls[p] }));
}

const STATE_KEYS = [
  "idle",
  "thinking",
  "tool_call",
  "editing",
  "waiting_user",
  "running_tests",
  "success",
  "error",
] as const;

// 水豚性格安静，8fps 比默认 12fps 更贴合原素材节奏
const states = Object.fromEntries(
  STATE_KEYS.map((s) => [s, { frames: framesFor(s), fps: 8 }]),
) as SpriteManifest["states"];

export const LULU_SKIN: SkinMeta = {
  id: "lulu-capybara",
  nameEn: "Lulu Capybara",
  nameZh: "噜噜",
  kind: "sprite",
  builtin: true,
  manifest: { states },
};
