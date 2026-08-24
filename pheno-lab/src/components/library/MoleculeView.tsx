"use client";

import { useEffect, useRef, useState } from "react";

// 2D structure drawing from SMILES (organic molecules only — salts and
// metals have no meaningful structure and are skipped by the caller).
// smiles-drawer 2.x exposes its classes on the module's default export.
export function MoleculeView({ smiles, height = 170 }: { smiles: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const code = smiles.trim();
    if (!code || !ref.current) return;
    let cancelled = false;
    setFailed(false);

    (async () => {
      try {
        const mod = await import("smiles-drawer");
        // smiles-drawer 2.x: classes hang off the default export and
        // Parser.parse is synchronous (returns the parse tree).
        const SD = (mod.default ?? mod) as {
          Drawer: new (o: object) => { draw: (tree: unknown, target: HTMLCanvasElement, theme: string) => void };
          Parser: { parse: (s: string) => unknown };
        };
        if (cancelled || !ref.current) return;
        const canvas = ref.current;
        const tree = SD.Parser.parse(code);
        const drawer = new SD.Drawer({
          width: canvas.width,
          height: canvas.height,
          bondThickness: 1.1,
          padding: 14,
          terminalCarbons: true,
        });
        drawer.draw(tree, canvas, "light");
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [smiles]);

  if (!smiles.trim() || failed) return null;
  return (
    <div className="bg-white border border-line rounded-[6px] flex items-center justify-center overflow-hidden">
      <canvas ref={ref} width={420} height={height} className="max-w-full" />
    </div>
  );
}
