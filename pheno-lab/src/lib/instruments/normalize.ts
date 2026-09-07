/** Normalize serials entered by hand on instrument PCs, including Chinese IME input. */
export function normalizeSerial(raw: string): string {
  return raw
    .trim()
    .replace(/[！-～]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
    )
    .toUpperCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A serial with every number unpadded: "26A010-3" → "26A10-3". Operators pad
 * numbers with zeros inconsistently ("26A010" for sample 26A10 broke a whole
 * group's data link on 2026-09-04), so matching compares this form when the
 * exact serial explains nothing. Zero alone survives ("A0" stays "A0").
 */
export function canonicalSerialKey(raw: string): string {
  return normalizeSerial(raw).replace(/\d+/g, (run) =>
    String(parseInt(run, 10)),
  );
}
