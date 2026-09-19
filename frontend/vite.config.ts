import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import wails from "@wailsio/runtime/plugins/vite";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 应用版本：单一来源 = build/config.yml 的 info.version（构建产物的版本号）。
// 通过 Vite define 注入 __APP_VERSION__，供前端（如侧栏版本号）读取。
function readAppVersion(): string {
  try {
    const cfg = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../build/config.yml"),
      "utf-8",
    );
    const m = cfg.match(/info:[\s\S]*?\n\s*version:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* 读不到则回落占位 */
  }
  return "0.0.0";
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [vue(), wails("./bindings")],
});
