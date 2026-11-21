import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Chrome cannot allocate a single surface for arbitrarily tall reports. Each capture
// uses document CSS coordinates, device scale 1, and the original viewport dimensions.
export async function captureFullPage(page, directory, stem) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const measure = async () => {
      const { cssContentSize: size } = await cdp.send("Page.getLayoutMetrics");
      return { width: Math.ceil(size.width), height: Math.ceil(size.height) };
    };
    const { width, height } = await measure();
    if (
      width !== page.viewportSize().width ||
      height < page.viewportSize().height
    ) {
      throw Error("Unexpected full report dimensions.");
    }
    const tiled = height > 8192;
    const stride = tiled ? 4096 : height;
    const strips = [];
    for (let top = 0; top < height; top += stride) {
      const h = Math.min(stride, height - top);
      const name = tiled
        ? `${stem}-strip-${strips.length + 1}.png`
        : `${stem}.png`;
      const capture = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: top, width, height: h, scale: 1 },
      });
      const bytes = Buffer.from(capture.data, "base64");
      if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== h) {
        throw Error(
          "Full report screenshot dimensions do not match its requested region.",
        );
      }
      await writeFile(join(directory, name), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      strips.push({
        name,
        top,
        height: h,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const final = await measure();
    if (final.width !== width || final.height !== height) {
      throw Error("Report dimensions changed during full-page capture.");
    }
    return { width, height, strips };
  } finally {
    await cdp.detach();
  }
}
