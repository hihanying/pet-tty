/** Skin package for PetDeck M2 */

export type SkinKind = "css" | "image" | "vector" | "sprite";

export type CssThemeId = "ember" | "mint" | "pixel-blob" | "ghost";

/** Per-state frame sequence for sprite characters (PNG sequence animation,
 *  e.g. imported DyberPet mods). */
export interface SpriteFrame {
  /** data URL (builtin skins) or runtime object URL (imported skins) */
  src: string;
  /** ms to show this frame (optional; falls back to the state's fps) */
  duration?: number;
}
export interface SpriteState {
  /** Embedded frames (builtin skins). Present => frames are self-contained. */
  frames?: SpriteFrame[];
  /** Frame count for imported skins whose blobs live in IndexedDB
   *  (keyed by skinId + state). Absent `frames` => player loads from IDB. */
  frameCount?: number;
  /** frames per second; default 12 */
  fps?: number;
  /** loop the sequence; default true */
  loop?: boolean;
}
export interface SpriteManifest {
  /** per agent state (AgentState values as keys); states without an entry
   *  fall back to "idle" at playback time. */
  states: Partial<Record<string, SpriteState>>;
}

export interface SkinMeta {
  id: string;
  /** display name EN */
  nameEn: string;
  nameZh: string;
  kind: SkinKind;
  /** built-in vs user-imported */
  builtin: boolean;
  /** css theme key when kind === css */
  theme?: CssThemeId;
  /** data URL when kind === image */
  imageDataUrl?: string;
  /** render with nearest-neighbor */
  pixelated?: boolean;
  /** vector character id when kind === vector */
  vectorId?: string;
  /** sprite manifest when kind === sprite (Phase 2) */
  manifest?: SpriteManifest;
  /** 显示框高度(px)，宽度按帧比例自适应；不设则用 .pet-sprite 默认 180x250 框。
   *  注意 object-fit:contain 会把小帧放大到框宽，想显示更小必须用这个。 */
  spriteDisplayHeight?: number;
  createdAt?: string;
}

export interface PixelizeOptions {
  /** output width in pixels (height keeps aspect) */
  size: number;
  /** max colors in palette (approx) */
  colors: number;
}
