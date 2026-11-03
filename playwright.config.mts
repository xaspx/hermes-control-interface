import { defineConfig, devices } from "@playwright/test";

// GSD UI runtime QA — Playwright CLI 표준 (영상 케이스 2 패턴, 2026-04-26)
// MCP보다 토큰 효율 + 자가학습 루프 호환.
// 사용처: ~/dev/* frontend 프로젝트의 자동 라우트 검증.

export default defineConfig({
  testDir: "./qa",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    // 프로젝트마다 baseURL 오버라이드 필요 (vite=5173, next=3000 등)
    baseURL: process.env.QA_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
