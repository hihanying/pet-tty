import type { SkinMeta } from "./types";
import { LULU_SKIN } from "./lulu";
import { VECTOR_CHARACTERS } from "./vector";

/** Built-in skins (no external assets). */
export const BUILTIN_SKINS: SkinMeta[] = [
  // 噜噜置顶：默认皮肤，也作为未知皮肤的回落项
  LULU_SKIN,
  {
    id: "ember",
    nameEn: "Ember Fox",
    nameZh: "焰狐",
    kind: "css",
    builtin: true,
    theme: "ember",
  },
  {
    id: "pixel-blob",
    nameEn: "Pixel Blob",
    nameZh: "像素团",
    kind: "css",
    builtin: true,
    theme: "pixel-blob",
  },
  {
    id: "ghost",
    nameEn: "Mono Ghost",
    nameZh: "幽灵",
    kind: "css",
    builtin: true,
    theme: "ghost",
  },
  // Original vector characters (SVG + CSS, hand-written, no external art).
  ...VECTOR_CHARACTERS.map((vc) => ({
    id: `vec-${vc.id}`,
    nameEn: vc.nameEn,
    nameZh: vc.nameZh,
    kind: "vector" as const,
    builtin: true,
    vectorId: vc.id,
  })),
];

export const DEFAULT_SKIN_ID = "lulu-capybara";
