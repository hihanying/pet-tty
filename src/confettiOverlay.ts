/**
 * 全屏礼花覆盖层（confetti.html 专用入口）。
 * 由 Rust 侧 confetti_burst 创建的透明置顶窗口加载，只播动画，
 * 不做任何 IPC / 桥接；窗口生命周期由 Rust 侧定时回收。
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 旋转角与角速度 */
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  /** 0=矩形纸屑 1=圆形 */
  shape: 0 | 1;
}

const COLORS = [
  "#ff5f6d",
  "#ffc371",
  "#47e5bc",
  "#4facfe",
  "#b06ab3",
  "#ffd166",
  "#ff8fab",
];

const DURATION_MS = 3000;
const FADE_MS = 600;
const COUNT = 170;

export function playConfettiOverlay(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  // 左右两门"礼炮"从底部两角向中上方喷射 + 顶部飘落，层次更好
  const parts: Particle[] = [];
  const spawnFrom = (ox: number, oy: number, dirX: number) => {
    for (let i = 0; i < COUNT / 2; i++) {
      const spread = (Math.random() - 0.5) * 0.9;
      const speed = 9 + Math.random() * 8;
      parts.push({
        x: ox,
        y: oy,
        vx: dirX * (3 + Math.random() * 5) + spread * 3,
        vy: -speed,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#ffd166",
        shape: Math.random() < 0.25 ? 1 : 0,
      });
    }
  };
  spawnFrom(W * 0.08, H + 10, 1);
  spawnFrom(W * 0.92, H + 10, -1);
  for (let i = 0; i < COUNT / 2; i++) {
    parts.push({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.3,
      vx: (Math.random() - 0.5) * 1.4,
      vy: 1.5 + Math.random() * 2.2,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.2,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#ff8fab",
      shape: Math.random() < 0.2 ? 1 : 0,
    });
  }

  const start = performance.now();
  const GRAVITY = 0.16;
  const DRAG = 0.985;

  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = t > DURATION_MS - FADE_MS ? Math.max(0, (DURATION_MS - t) / FADE_MS) : 1;

    for (const p of parts) {
      p.vy += GRAVITY;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 1) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 绕 X 轴翻转的近似：高度按 cos 压缩，纸片有翻飞感
        const fh = Math.max(1, Math.abs(p.h * Math.cos(p.rot * 1.7)));
        ctx.fillRect(-p.w / 2, -fh / 2, p.w, fh);
      }
      ctx.restore();
    }

    if (t < DURATION_MS) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
