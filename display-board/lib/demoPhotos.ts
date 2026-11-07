import type { Order } from "./types";

// Fallback photos for when the camera or Wi-Fi fails during the demo.
// Swap in real meal photos: drop files in public/demo/ and update this list.
export const DEMO_PHOTOS: { src: string; label: string }[] = [
  { src: "/demo/burger-lettuce.svg", label: "Burger w/ lettuce" },
  { src: "/demo/burger-no-lettuce.svg", label: "Burger, no lettuce" },
  { src: "/demo/burger-fries.svg", label: "Burger + fries" },
  { src: "/demo/fries-soda.svg", label: "Fries + soda" },
];

/** The demo photo that best matches an order's ticket. */
export function demoPhotoFor(order: Order): string {
  const ids = order.items.map((i) => i.menu_id);
  const burger = order.items.find((i) => i.menu_id === "burger");
  if (burger && ids.includes("fries")) return "/demo/burger-fries.svg";
  if (burger) return burger.mods?.lettuce === false ? "/demo/burger-no-lettuce.svg" : "/demo/burger-lettuce.svg";
  if (ids.includes("fries")) return "/demo/fries-soda.svg";
  return DEMO_PHOTOS[0].src;
}
