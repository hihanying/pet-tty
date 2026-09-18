import type { AgentState } from "../events/types";
import { PET_VISUAL } from "../pet/mood";
import { getVectorCharacter } from "./vector";
import { spritePlayer } from "./spritePlayer";
import type { SkinMeta } from "./types";

/**
 * Apply active skin + agent state to the #pet element tree.
 */
export function applySkinToDom(
  petRoot: HTMLElement,
  skin: SkinMeta,
  state: AgentState,
) {
  const visual = PET_VISUAL[state];
  const cssBody = petRoot.querySelector(".pet-css") as HTMLElement | null;
  const img = petRoot.querySelector(".pet-img") as HTMLImageElement | null;
  const face = petRoot.querySelector(".pet-face") as HTMLElement | null;
  const vectorBox = petRoot.querySelector(".pet-vector") as HTMLElement | null;
  const spriteImg = petRoot.querySelector(".pet-sprite") as HTMLImageElement | null;

  petRoot.className = `pet ${visual.bodyClass}`;
  petRoot.dataset.skinKind = skin.kind;
  petRoot.dataset.theme = skin.theme ?? "";
  petRoot.dataset.skinId = skin.id;
  petRoot.dataset.vector = skin.vectorId ?? "";

  const hideAllLayers = () => {
    cssBody?.classList.add("hidden");
    img?.classList.add("hidden");
    if (img) img.removeAttribute("src");
    vectorBox?.classList.add("hidden");
    spriteImg?.classList.add("hidden");
  };

  // Stop the sprite player unless this is a sprite skin.
  if (skin.kind !== "sprite") spritePlayer.deactivate();

  if (skin.kind === "sprite" && spriteImg) {
    hideAllLayers();
    spriteImg.classList.remove("hidden");
    spriteImg.classList.toggle("pixelated", !!skin.pixelated);
    // 皮肤可指定显示高度（宽度按比例）；未指定则还原 CSS 默认框
    if (skin.spriteDisplayHeight) {
      spriteImg.style.width = "auto";
      spriteImg.style.height = `${skin.spriteDisplayHeight}px`;
    } else {
      spriteImg.style.width = "";
      spriteImg.style.height = "";
    }
    spritePlayer.attach(spriteImg);
    spritePlayer.activate(skin);
    spritePlayer.setState(state);
    return;
  }

  if (skin.kind === "vector" && skin.vectorId && vectorBox) {
    const vc = getVectorCharacter(skin.vectorId);
    hideAllLayers();
    if (vc) {
      vectorBox.classList.remove("hidden");
      vectorBox.innerHTML = vc.svg;
    }
  } else if (skin.kind === "image" && skin.imageDataUrl && img && cssBody) {
    hideAllLayers();
    img.classList.remove("hidden");
    img.src = skin.imageDataUrl;
    img.classList.toggle("pixelated", !!skin.pixelated);
    img.alt = skin.nameEn;
  } else if (cssBody && img) {
    hideAllLayers();
    cssBody.classList.remove("hidden");
    petRoot.classList.add(`theme-${skin.theme ?? "ember"}`);
    // remove other themes
    for (const t of ["ember", "mint", "pixel-blob", "ghost"]) {
      if (t !== skin.theme) petRoot.classList.remove(`theme-${t}`);
    }
    if (face) face.textContent = visual.face;
  }
}
