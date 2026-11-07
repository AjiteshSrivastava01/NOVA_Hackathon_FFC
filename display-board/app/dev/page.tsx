import type { Metadata } from "next";
import DevPanel from "@/components/DevPanel";

export const metadata: Metadata = { title: "Dev controls · Front House", robots: { index: false } };

/** Team-only testing controls. Never on the projector. */
export default function DevPage() {
  return <DevPanel />;
}
