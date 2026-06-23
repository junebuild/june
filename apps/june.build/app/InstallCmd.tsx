"use client";
// The copyable install command — June's primary CTA. Server-renders the pill;
// hydration wires the copy button (clipboard needs the client).
import { useState } from "react";

export function InstallCmd({ cmd = "npm create june@latest my-app" }: { cmd?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(cmd);
    } catch {
      /* noop */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="j-cmd">
      <span className="j-cmd-text">
        <span className="j-cmd-prompt">$ </span>npm create <b>june@latest</b> my-app
      </span>
      <button
        type="button"
        className={"j-copy" + (copied ? " is-copied" : "")}
        onClick={copy}
        aria-label="Copy install command"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </div>
  );
}
