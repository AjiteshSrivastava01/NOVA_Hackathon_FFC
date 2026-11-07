import type { Metadata } from "next";
import CameraFlow from "@/components/CameraFlow";

export const metadata: Metadata = { title: "Meal check · Front House" };

/** Staff phone: pick ticket → photograph meal → result (+ swap confirmation). */
export default function CameraPage() {
  return <CameraFlow />;
}
