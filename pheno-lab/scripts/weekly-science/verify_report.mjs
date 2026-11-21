import { chromium, expect } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
process.umask(0o077);
const policySource = fileURLToPath(
  new URL("../../src/modules/reports/html.ts", import.meta.url),
);
const { reportContentSecurityPolicy } = await tsImport(
  policySource,
  import.meta.url,
);
const [inputPath, qaPath] = process.argv.slice(2);
if (!inputPath || !qaPath)
  throw new Error(
    "Usage: node verify_report.mjs report.html private-qa-directory",
  );
const input = resolve(inputPath),
  qa = resolve(qaPath),
  html = await readFile(input, "utf8");
await mkdir(qa, { mode: 0o700 });
const policy = reportContentSecurityPolicy(html);
expect(policy).not.toContain("unsafe-inline");
expect(policy).not.toContain("allow-same-origin");
expect(policy).toContain("connect-src 'none'");
expect(policy).toContain("img-src data:");
const viewSource = await readFile(
  new URL("../../src/app/(app)/reports/[id]/page.tsx", import.meta.url),
  "utf8",
);
const sandbox = viewSource.match(/<iframe\b[^>]*?\bsandbox="([^"]+)"/s)?.[1];
expect(sandbox).toBe(
  "allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox",
);
expect(
  policy.split("; ").filter((rule) => rule.startsWith("sandbox ")),
).toEqual(["sandbox " + sandbox]);
const shell =
  '<html><body style="margin:0"><iframe title="Report QA" src="/report" sandbox="' +
  sandbox +
  '" referrerpolicy="no-referrer" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>';
const browser = await chromium.launch({ headless: true });
const cases = [],
  baselines = new Map();
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Compare the complete rendered chart state, rather than element existence. This
// catches CSP-blocked SVG paint/fonts even when the page has no pageerror.
const openAppendices = () => {
  const details = [...document.querySelectorAll("details")];
  const previous = details.map((node) => node.open);
  for (const node of details) node.open = true;
  return previous;
};
const restoreAppendices = (previous) => {
  [...document.querySelectorAll("details")].forEach(
    (node, i) => (node.open = previous[i]),
  );
};
const svgStates = () =>
  [...document.querySelectorAll("figure svg")]
    .filter(
      (svg) =>
        svg.getBoundingClientRect().width > 0 &&
        svg.getBoundingClientRect().height > 0,
    )
    .map((svg) => ({
      section: svg.closest("section")?.id || "",
      nodes: [svg, ...svg.querySelectorAll("*")].map((node) => {
        const style = getComputedStyle(node),
          props = {};
        for (const key of [
          "fill",
          "fill-opacity",
          "fill-rule",
          "stroke",
          "stroke-width",
          "stroke-opacity",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-miterlimit",
          "stroke-dasharray",
          "stroke-dashoffset",
          "opacity",
          "font-family",
          "font-size",
          "font-style",
          "font-weight",
          "text-anchor",
          "dominant-baseline",
          "alignment-baseline",
          "shape-rendering",
          "paint-order",
          "vector-effect",
        ])
          props[key] = style.getPropertyValue(key);
        const geometry = {};
        for (const key of [
          "d",
          "points",
          "x",
          "y",
          "x1",
          "y1",
          "x2",
          "y2",
          "cx",
          "cy",
          "r",
          "rx",
          "ry",
          "width",
          "height",
          "viewBox",
          "transform",
          "clip-path",
          "href",
          "xlink:href",
        ])
          if (node.hasAttribute(key)) geometry[key] = node.getAttribute(key);
        let bounds = null;
        if (node.localName === "text") {
          const b = node.getBBox();
          bounds = [b.x, b.y, b.width, b.height].map(
            (v) => Math.round(v * 1000000) / 1000000,
          );
        }
        return {
          tag: node.localName,
          props,
          geometry,
          text: node.localName === "text" ? node.textContent : null,
          bounds,
        };
      }),
    }));
const documentState = () => {
  const anchors = [...document.querySelectorAll("nav.toc a")];
  const rectangles = anchors.map((anchor) => anchor.getBoundingClientRect());
  const overlaps = rectangles.filter((a, i) =>
    rectangles
      .slice(i + 1)
      .some(
        (b) =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
      ),
  ).length;
  const incompleteLinks = anchors.filter((anchor, i) => {
    const section = document.getElementById(anchor.hash.slice(1));
    const box = rectangles[i];
    return (
      !anchor.innerText.trim() ||
      section?.tagName !== "SECTION" ||
      box.width < 1 ||
      box.height < 1 ||
      box.left < -1 ||
      box.right > innerWidth + 1
    );
  }).length;
  return {
    overflow: document.documentElement.scrollWidth > innerWidth,
    brokenImages: [...document.images].filter(
      (i) => !i.complete || !i.naturalWidth,
    ).length,
    sections: document.querySelectorAll("section").length,
    navigation: {
      uniqueTargets: new Set(anchors.map((anchor) => anchor.hash)).size,
      links: anchors.length,
      overlaps,
      incompleteLinks,
    },
    visibleWrongLanguage: [...document.querySelectorAll("[data-lang]")].filter(
      (e) => e.dataset.lang !== document.documentElement.lang && !e.hidden,
    ).length,
    buttonHeight: Math.min(
      ...[...document.querySelectorAll("button")].map(
        (b) => b.getBoundingClientRect().height,
      ),
    ),
  };
};
const assertState = (state) => {
  expect(state.overflow).toBe(false);
  expect(state.brokenImages).toBe(0);
  expect(state.sections).toBeGreaterThan(0);
  expect(state.navigation).toEqual({
    uniqueTargets: state.sections,
    links: state.sections,
    overlaps: 0,
    incompleteLinks: 0,
  });
  expect(state.visibleWrongLanguage).toBe(0);
  expect(state.buttonHeight).toBeGreaterThanOrEqual(44);
};
try {
  for (const lang of ["en", "zh"])
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 700],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        offline: true,
      });
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (/^https?:/.test(r.url())) requests.push(r.url());
      });
      await page.goto(pathToFileURL(input).href + "#lang=" + lang);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      const state = await page.evaluate(documentState);
      assertState(state);
      const openStates = await page.evaluate(openAppendices);
      const chartStates = await page.evaluate(svgStates);
      await page.evaluate(restoreAppendices, openStates);
      baselines.set(lang + "-" + width, chartStates);
      expect(errors).toEqual([]);
      expect(requests).toEqual([]);
      await page.screenshot({
        path: qa + "/" + lang + "-" + width + ".png",
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: lang === "en" ? "中文" : "English",
          exact: true,
        })
        .click();
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        lang === "en" ? "zh" : "en",
      );
      await page
        .getByRole("button", {
          name: lang === "en" ? "English" : "中文",
          exact: true,
        })
        .click();
      await page.evaluate(() => {
        window.__printed = 0;
        window.print = () => window.__printed++;
      });
      await page.locator("#print").click();
      expect(await page.evaluate(() => window.__printed)).toBe(1);
      const detailsBefore = await page.locator("details[open]").count();
      await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
      expect(await page.locator("details[open]").count()).toBe(
        await page.locator("details").count(),
      );
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      expect(await page.locator("details[open]").count()).toBe(detailsBefore);
      if (width === 1440) {
        await page.pdf({
          path: qa + "/" + lang + "-print.pdf",
          preferCSSPageSize: true,
          printBackground: true,
        });
        expect(await page.locator("details[open]").count()).toBe(detailsBefore);
      }
      cases.push({
        mode: "offline",
        lang,
        width,
        height,
        ...state,
        errors,
        externalRequests: requests.length,
        toggle: true,
        printControl: true,
        chartCount: chartStates.length,
        chartFingerprint: digest(chartStates),
      });
      await context.close();
    }
  for (const lang of ["en", "zh"])
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 700],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } }),
        page = await context.newPage(),
        errors = [],
        cspErrors = [],
        requests = [];
      await context.addInitScript(() => {
        globalThis.__qaCspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) =>
          globalThis.__qaCspViolations.push({
            directive: event.effectiveDirective,
            disposition: event.disposition,
            blockedURI:
              event.blockedURI === "inline" ? "inline" : "blocked-resource",
          }),
        );
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          /Content Security Policy|violates.*(?:style|script|img|connect)-src/i.test(
            message.text(),
          )
        )
          cspErrors.push(message.text().slice(0, 120));
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin === "https://report-qa.local" &&
          url.pathname === "/shell"
        )
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: shell.replace("/report", "/report#lang=" + lang),
          });
        if (
          url.origin === "https://report-qa.local" &&
          url.pathname === "/report"
        )
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            headers: {
              "Content-Security-Policy": policy,
              "Cache-Control": "private, no-store",
            },
            body: html,
          });
        requests.push("unexpected-network-request");
        return route.abort();
      });
      await page.goto("https://report-qa.local/shell");
      const frame = page
        .frames()
        .find((frame) => new URL(frame.url()).pathname === "/report");
      if (!frame) throw new Error("Sandboxed report frame did not load.");
      await expect(frame.locator("html")).toHaveAttribute("lang", lang);
      const state = await frame.evaluate(documentState);
      assertState(state);
      await page.screenshot({
        path: qa + "/" + lang + "-" + width + "-viewport.png",
        fullPage: false,
      });
      const openStates = await frame.evaluate(openAppendices);
      const chartStates = await frame.evaluate(svgStates),
        baseline = baselines.get(lang + "-" + width);
      if (digest(chartStates) !== digest(baseline))
        throw new Error(
          "Sandboxed CSP changed chart geometry, labels or computed paint/font state (" +
            lang +
            ", " +
            width +
            ").",
        );
      const security = await frame.evaluate(() => ({
        opaqueOrigin: globalThis.origin === "null",
        parentAccessBlocked: (() => {
          try {
            void parent.document;
            return false;
          } catch {
            return true;
          }
        })(),
        storageBlocked: (() => {
          try {
            void localStorage.length;
            return false;
          } catch {
            return true;
          }
        })(),
      }));
      expect(security).toEqual({
        opaqueOrigin: true,
        parentAccessBlocked: true,
        storageBlocked: true,
      });
      let photographedFigures = 0;
      let photographedCharts = 0;
      if (width === 1440 || width === 390) {
        const figures = frame.locator("figure:visible");
        for (let index = 0; index < (await figures.count()); index++) {
          const figure = figures.nth(index);
          const visibleCharts = await figure.locator("svg:visible").count();
          if (!visibleCharts) continue;
          photographedFigures++;
          photographedCharts += visibleCharts;
          await figure.evaluate((node) => (node.scrollLeft = 0));
          await figure.screenshot({
            path:
              qa +
              "/" +
              lang +
              "-" +
              width +
              "-csp-chart-" +
              (index + 1) +
              ".png",
          });
          if (
            width === 390 &&
            (await figure.evaluate(
              (node) => node.scrollWidth > node.clientWidth,
            ))
          ) {
            await figure.evaluate(
              (node) => (node.scrollLeft = node.scrollWidth),
            );
            await figure.screenshot({
              path:
                qa +
                "/" +
                lang +
                "-" +
                width +
                "-csp-chart-" +
                (index + 1) +
                "-right.png",
            });
          }
        }
        expect(photographedCharts).toBe(chartStates.length);
      }
      await frame.evaluate(restoreAppendices, openStates);
      await frame
        .getByRole("button", {
          name: lang === "en" ? "中文" : "English",
          exact: true,
        })
        .click();
      await expect(frame.locator("html")).toHaveAttribute(
        "lang",
        lang === "en" ? "zh" : "en",
      );
      await frame
        .getByRole("button", {
          name: lang === "en" ? "English" : "中文",
          exact: true,
        })
        .click();
      await expect(frame.locator("html")).toHaveAttribute("lang", lang);
      const violations = await frame.evaluate(
        () => globalThis.__qaCspViolations || [],
      );
      expect(violations).toEqual([]);
      expect(cspErrors).toEqual([]);
      expect(errors).toEqual([]);
      expect(requests).toEqual([]);
      cases.push({
        mode: "app-equivalent-csp-sandbox",
        photographedFigures,
        photographedCharts,
        lang,
        width,
        height,
        ...state,
        ...security,
        chartCount: chartStates.length,
        chartFingerprint: digest(chartStates),
        matchesOfflinePaintFontsGeometryAndLabels: true,
        cspViolations: violations.length,
        cspConsoleErrors: cspErrors.length,
        errors,
        externalRequests: requests.length,
        toggle: true,
      });
      await context.close();
    }
} finally {
  await browser.close();
}
const printInspector = fileURLToPath(
  new URL("./inspect_print_pages.py", import.meta.url),
);
execFileSync("python3", ["-B", printInspector, qa], {
  stdio: ["ignore", "ignore", "inherit"],
  timeout: 720_000,
});
const printPages = JSON.parse(await readFile(qa + "/print-pages.json", "utf8"));
await writeFile(
  qa + "/verification.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      report: input,
      contentSecurityPolicy: policy,
      sourcePolicy: policySource,
      renderedPrintPages: Object.fromEntries(
        Object.entries(printPages.languages).map(([language, result]) => [
          language,
          result.pages.length,
        ]),
      ),
      cases,
      passed: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    passed: true,
    cases: cases.length,
    strictCspCases: cases.filter((c) => c.mode === "app-equivalent-csp-sandbox")
      .length,
  }),
);
