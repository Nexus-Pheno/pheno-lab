"use client";

import { useEffect } from "react";

// Ring buffer of recent client-side errors, attached to bug reports so agents
// get real context. Loaded once in the app layout.
declare global {
  interface Window {
    __phenoErrors?: string[];
  }
}

export function ErrorCollector() {
  useEffect(() => {
    if (window.__phenoErrors) return;
    const buf: string[] = [];
    window.__phenoErrors = buf;
    const push = (line: string) => {
      buf.push(`[${new Date().toISOString()}] ${line}`);
      if (buf.length > 30) buf.shift();
    };
    window.addEventListener("error", (e) => push(`error: ${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => push(`unhandledrejection: ${String(e.reason).slice(0, 300)}`));
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      push("console.error: " + args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 300));
      origError(...args);
    };
  }, []);
  return null;
}
