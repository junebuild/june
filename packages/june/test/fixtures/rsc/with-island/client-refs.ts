import { registerClientReference } from "react-server-dom-webpack/server";
import type React from "react";
// In a real build the "use client" codegen emits these; registered by hand here.
export const Tabs = registerClientReference({}, "rsc/Tabs", "Tabs") as unknown as React.FC<{
  children?: React.ReactNode;
}>;
