/** Milanote-style soft card tints. `key` is what we persist in items.card_color. */
export interface CardTint {
  key: string;
  label: string;
  /** Solid swatch colour for the picker dot. */
  swatch: string;
  /** Card background + border classes when this tint is applied. */
  card: string;
}

/** The default (no tint) card surface — kept in one place so the picker can show it too. */
export const DEFAULT_CARD = "bg-[#17171c] border-white/10";

export const CARD_TINTS: CardTint[] = [
  { key: "amber", label: "Amber", swatch: "bg-amber-400", card: "bg-amber-500/15 border-amber-400/25" },
  { key: "yellow", label: "Yellow", swatch: "bg-yellow-300", card: "bg-yellow-400/15 border-yellow-300/25" },
  { key: "green", label: "Green", swatch: "bg-emerald-400", card: "bg-emerald-500/15 border-emerald-400/25" },
  { key: "blue", label: "Blue", swatch: "bg-sky-400", card: "bg-sky-500/15 border-sky-400/25" },
  { key: "violet", label: "Violet", swatch: "bg-violet-400", card: "bg-violet-500/15 border-violet-400/25" },
  { key: "pink", label: "Pink", swatch: "bg-pink-400", card: "bg-pink-500/15 border-pink-400/25" },
];

/** Resolve a stored card_color key to its card surface classes (falls back to default). */
export function cardSurface(key: string | null | undefined): string {
  if (!key) return DEFAULT_CARD;
  return CARD_TINTS.find((t) => t.key === key)?.card ?? DEFAULT_CARD;
}

/** Text colours offered in the note editor's colour menu. */
export const TEXT_COLORS: { label: string; value: string }[] = [
  { label: "Default", value: "" },
  { label: "Amber", value: "#fbbf24" },
  { label: "Green", value: "#34d399" },
  { label: "Blue", value: "#60a5fa" },
  { label: "Violet", value: "#a78bfa" },
  { label: "Pink", value: "#f472b6" },
  { label: "Red", value: "#f87171" },
];
