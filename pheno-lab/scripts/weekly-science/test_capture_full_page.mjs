import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { captureFullPage } from "./capture_full_page.mjs";

const root = await mkdtemp(join(tmpdir(), "weekly-capture-test-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  for (const height of [900, 67_321]) {
    // Distinct bands and a partial final band exercise high page coordinates and the last row.
    const colors = ["#ff0000", "#00ff00", "#0000ff"];
    const rows = [];
    for (let top = 0; top < height; top += 4096)
      rows.push(
        '<div style="height:' +
          Math.min(4096, height - top) +
          "px;background:" +
          colors[rows.length % 3] +
          '"></div>',
      );
    await page.setContent(
      '<body style="margin:0">' + rows.join("") + "</body>",
    );
    const result = await captureFullPage(page, root, "test-" + height);
    assert.equal(result.height, height);
    assert.equal(result.width, 320);
    let expectedTop = 0;
    for (const [i, region] of result.strips.entries()) {
      assert.equal(region.top, expectedTop);
      const bytes = await readFile(join(root, region.name));
      const colorsRead = await page.evaluate(
        async ({ png, height }) => {
          const img = new Image();
          img.src = "data:image/png;base64," + png;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const pixel = (y) =>
            Array.from(ctx.getImageData(3, y, 1, 1).data).slice(0, 3);
          return [pixel(0), pixel(height - 1)];
        },
        { png: bytes.toString("base64"), height: region.height },
      );
      const expected = [0, 0, 0];
      expected[i % 3] = 255;
      assert.deepEqual(colorsRead, [expected, expected]);
      expectedTop += region.height;
    }
    assert.equal(expectedTop, height);
    assert.equal(result.strips.length, height === 900 ? 1 : 17);
  }
} finally {
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
