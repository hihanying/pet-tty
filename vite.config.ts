import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  clearScreen: false,
  // 多页构建：confetti.html 是成功礼花覆盖层的独立入口（Rust confetti_burst 加载）
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        confetti: "confetti.html",
      },
    },
  },
  // @imgly/background-removal pulls ONNX / wasm — keep out of optimizeDeps
  optimizeDeps: {
    exclude: ["@imgly/background-removal"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
