import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
const sha = (v) => createHash("sha256").update(v).digest("hex");
async function preserve(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      !(await readFile(path)).equals(Buffer.from(bytes))
    )
      throw error;
  }
}

// The original view must be reproduced byte-for-byte under the exact app CSP.
// Only a table header actually crossing the bottom of a scrolling viewport qualifies.
export async function captureViewportBoundary({
  page,
  frame,
  qa,
  reviews,
  original,
  html,
  policy,
  sandbox,
  errors,
  requests,
  cspErrors,
}) {
  const gate = dirname(qa),
    raw = await readFile(join(gate, "challenge.json")),
    ch = JSON.parse(raw);
  const origin = ch.images.find((x) => x.file === original),
    match = /^qa\/((en|zh)-(320|390|1024|1440)-viewport)\.png$/.exec(original);
  if (
    !origin ||
    !match ||
    sha(html) !== ch.contentSha256 ||
    sha(await readFile(join(qa, basename(original)))) !== origin.sha256 ||
    sha(await page.screenshot()) !== origin.sha256
  )
    throw Error("Original viewport pixels do not reproduce under app policy.");
  const stem = match[1],
    lang = match[2],
    width = Number(match[3]);
  const before = await frame.evaluate(() => {
    const h = innerHeight;
    const headers = [...document.querySelectorAll("thead")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && r.top > 0 && r.top < h && r.bottom > h;
    });
    if (
      headers.length !== 1 ||
      scrollX !== 0 ||
      scrollY !== 0 ||
      document.documentElement.scrollWidth !== innerWidth
    )
      throw Error("A single table header must cross the lower viewport edge.");
    const header = headers[0],
      table = header.closest("table"),
      wrap = table?.closest(".table-wrap"),
      row = table?.tBodies[0]?.rows[0];
    if (
      !wrap ||
      !row ||
      header.rows.length !== 1 ||
      row.cells.length !== header.rows[0].cells.length ||
      !row.cells.length ||
      wrap.scrollTop ||
      wrap.scrollLeft
    )
      throw Error("Incompatible or empty table header or data row.");
    for (let e = table; e; e = e.parentElement)
      if (["hidden", "clip"].includes(getComputedStyle(e).overflowY))
        throw Error("A table ancestor clips vertical content.");
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const dims = (el) =>
      [...el.cells].map((c) => {
        const range = document.createRange();
        range.selectNodeContents(c);
        const r = range.getBoundingClientRect();
        if (
          !c.innerText.trim() ||
          r.height <= 0 ||
          c.scrollWidth > c.clientWidth + 1
        )
          throw Error("Cell text is empty or truncated.");
        return {
          text: c.innerText.trim(),
          box: rect(c),
          textBox: {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
          },
        };
      });
    return {
      lang: document.documentElement.lang,
      width: innerWidth,
      height: h,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      tableIndex: [...document.querySelectorAll("table")].indexOf(table),
      scrollX,
      scrollY,
      tableWidth: wrap.scrollWidth,
      tableClientWidth: wrap.clientWidth,
      visibleLeft: wrap.getBoundingClientRect().left + wrap.clientLeft,
      overflowX: getComputedStyle(wrap).overflowX,
      header: rect(header),
      firstRow: rect(row),
      cells: [...dims(header.rows[0]), ...dims(row)],
      security: {
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
      },
    };
  });
  if (
    before.lang !== lang ||
    before.width !== width ||
    Object.values(before.security).some((v) => v !== true)
  )
    throw Error("Wrong viewport context.");
  for (const c of before.cells) {
    c.textSha256 = sha(c.text);
    delete c.text;
  }
  const offset = Math.floor(before.height / 2);
  const maxPan = Math.max(0, before.tableWidth - before.tableClientWidth);
  if (maxPan && !["auto", "scroll"].includes(before.overflowX))
    throw Error("Table columns cannot be scrolled into view.");
  const offsets = [0];
  if (maxPan) offsets.push(maxPan);
  for (const c of before.cells) {
    const r = c.textBox,
      left = before.visibleLeft,
      w = before.tableClientWidth;
    if (
      !offsets.some(
        (x) => r.left - x >= left - 1 && r.right - x <= left + w + 1,
      )
    )
      offsets.push(
        Math.max(
          0,
          Math.min(maxPan, Math.round((r.left + r.right) / 2 - left - w / 2)),
        ),
      );
  }
  const pans = [...new Set(offsets)].sort((a, b) => a - b);
  if (pans.length > 6)
    throw Error("Too many corroborating views for an unambiguous review.");
  const views = [];
  for (const [i, pan] of pans.entries()) {
    const observed = await frame.evaluate(
      async ({ index, offset, pan }) => {
        const t = document.querySelectorAll("table")[index],
          wrap = t.closest(".table-wrap");
        window.scrollTo({ left: 0, top: offset, behavior: "instant" });
        wrap.scrollTo({ left: pan, top: 0, behavior: "instant" });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const h = t.tHead,
          row = t.tBodies[0].rows[0];
        const rect = (e) => {
          const r = e.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const cells = [...h.rows[0].cells, ...row.cells].map((c) => {
          const range = document.createRange();
          range.selectNodeContents(c);
          const r = range.getBoundingClientRect();
          return {
            text: c.innerText.trim(),
            box: rect(c),
            textBox: {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            },
          };
        });
        return {
          scrollY,
          scrollX,
          panX: wrap.scrollLeft,
          width: innerWidth,
          height: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          header: rect(h),
          firstRow: rect(row),
          cells,
        };
      },
      { index: before.tableIndex, offset, pan },
    );
    if (
      observed.scrollY !== offset ||
      observed.scrollX !== 0 ||
      observed.panX !== pan ||
      observed.header.top < 0 ||
      observed.firstRow.bottom > before.height ||
      observed.documentWidth !== before.documentWidth ||
      observed.documentHeight !== before.documentHeight
    )
      throw Error(
        "The continuation cannot show the complete header and first data row.",
      );
    for (const [j, c] of observed.cells.entries()) {
      c.textSha256 = sha(c.text);
      delete c.text;
      if (c.textSha256 !== before.cells[j].textSha256)
        throw Error("Table text changed during capture.");
    }
    const file =
      i === 0
        ? `boundary-${stem}-continuation.png`
        : `boundary-${stem}-pan-${i}.png`;
    const bytes = await page.screenshot();
    await preserve(join(reviews, file), bytes);
    views.push({ file, sha256: sha(bytes), ...observed });
  }
  const violations = await frame.evaluate(
    () => globalThis.__qaCspViolations || [],
  );
  if (errors.length || requests.length || cspErrors.length || violations.length)
    throw Error("Page security or network evidence changed.");
  const checks = {
    policySha256: sha(policy),
    sandbox,
    cspViolations: 0,
    cspConsoleErrors: 0,
    externalRequests: 0,
  };
  const files = views.map(({ file, sha256 }) => ({ file, sha256 }));
  const evidence = {
    schemaVersion: 1,
    challengeSha256: sha(raw),
    contentSha256: ch.contentSha256,
    original: origin,
    continuation: files[0],
    horizontalViews: files.slice(1),
    geometry: { before, views, checks },
  };
  await preserve(
    join(reviews, `boundary-evidence-${stem}.json`),
    JSON.stringify(evidence),
  );
}
