import { test, expect, type ConsoleMessage } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// GSD UI runtime QA template (영상 케이스 2 패턴, 2026-04-26)
//
// 사용법:
//   1) 이 파일을 프로젝트 루트의 qa/qa-routes.spec.mts 로 복사
//   2) ROUTES 배열을 프로젝트 라우트로 채우기
//      - SPA hash 라우트:  { hash: "#home", name: "home" }
//      - path 라우트:      { path: "/skills", name: "skills" }
//   3) `npx playwright test` 실행
//
// 출력:
//   qa/screenshots/*.png
//   qa/qa-report.json
//
// 검증 게이트 (gsd-ui-auditor가 사용):
//   - HARD: pageErrors.length === 0
//   - SOFT: failedRequests where status >= 500 (backend 미가동 vs 진짜 5xx)
//   - SOFT: consoleErrors count

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Route =
  | { hash: string; name: string }
  | { path: string; name: string };

// === EDIT THIS ARRAY FOR EACH PROJECT ===
const ROUTES: Route[] = [
  { hash: "#home", name: "home" },
  { hash: "#agents", name: "agents" },
  { hash: "#usage", name: "usage" },
  { hash: "#skills", name: "skills" },
  { hash: "#chat", name: "chat" },
  { hash: "#logs", name: "logs" },
  { hash: "#maintenance", name: "maintenance" },
  { hash: "#files", name: "files" },
];

const REPORT_DIR = path.resolve(__dirname, "screenshots");
const REPORT_FILE = path.resolve(__dirname, "qa-report.json");
fs.mkdirSync(REPORT_DIR, { recursive: true });

type Finding = {
  route: string;
  loadMs: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: { url: string; status: number }[];
  screenshot: string;
};

const findings: Finding[] = [];

test.afterAll(() => {
  fs.writeFileSync(REPORT_FILE, JSON.stringify(findings, null, 2));
  const issues = findings.reduce(
    (n, f) => n + f.consoleErrors.length + f.pageErrors.length + f.failedRequests.length,
    0,
  );
  console.log(`\n[QA] ${findings.length} routes checked, ${issues} issues found`);
  console.log(`[QA] Report: ${REPORT_FILE}`);
});

for (const route of ROUTES) {
  const target = "hash" in route ? `/${route.hash}` : route.path;
  test(`route ${target} renders`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: { url: string; status: number }[] = [];

    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    page.on("response", (resp) => {
      if (resp.status() >= 400) {
        failedRequests.push({ url: resp.url(), status: resp.status() });
      }
    });

    const start = Date.now();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(800);
    const loadMs = Date.now() - start;

    const screenshot = path.join(REPORT_DIR, `${route.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });

    findings.push({
      route: target,
      loadMs,
      consoleErrors,
      pageErrors,
      failedRequests,
      screenshot,
    });

    expect(pageErrors, `pageerror on ${target}`).toEqual([]);
  });
}
