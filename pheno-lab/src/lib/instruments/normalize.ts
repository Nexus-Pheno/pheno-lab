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
