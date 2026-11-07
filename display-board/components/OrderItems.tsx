import { describeMods, getMenuItem } from "@/lib/menu";
import type { OrderItem } from "@/lib/types";

export function OrderItems({ items, size = "md" }: { items: OrderItem[]; size?: "sm" | "md" | "lg" }) {
  const text = size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <ul className={`space-y-1 ${text}`}>
      {items.map((it, i) => {
        const m = getMenuItem(it.menu_id);
        const mods = describeMods(it);
        return (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span aria-hidden>{m?.emoji ?? "🍽️"}</span>
            <span className="font-semibold whitespace-nowrap">
              {it.qty}× {m?.name ?? it.menu_id}
            </span>
            {mods.length > 0 && (
              <span className="text-graphite-soft">
                {mods.map((t) => (
                  <span
                    key={t}
                    className={`mr-1 inline-block rounded px-1.5 text-[0.85em] font-medium ${
                      t.startsWith("no ") ? "bg-graphite text-apricot" : "bg-apricot"
                    }`}
                  >
                    {t}
                  </span>
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
