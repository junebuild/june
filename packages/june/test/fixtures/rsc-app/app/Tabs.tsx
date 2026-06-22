"use client";
import type React from "react";
export function Tabs({ children }: { children?: React.ReactNode }) {
  return <div data-island="tabs">{children}</div>;
}
