/**
 * Phase 2: Colour swatches (CIELAB) and structured facet vocabulary for the brief builder.
 *
 * LAB_SWATCHES: perceptually-calibrated target colours for delta-E colour-verified discovery.
 * FACET_VOCABULARY: controlled labels per facet axis — enables filterable, explainable matches.
 */

export interface LabSwatch {
  name: string;
  hex: string;                    // for rendering the swatch
  lab: [number, number, number];  // CIE L*a*b* for delta-E matching
}

/** Palette swatches covering the common brief vocabulary.
 *  LAB values computed from representative hex via standard sRGB→XYZ→LAB (D65). */
export const LAB_SWATCHES: LabSwatch[] = [
  { name: "Black",       hex: "#111111", lab: [5.0,   0.0,   0.0] },
  { name: "Dark Navy",   hex: "#0d1b2e", lab: [10.0,  0.5, -10.0] },
  { name: "Dark Blue",   hex: "#1a2f5e", lab: [18.0,  5.0, -28.0] },
  { name: "Slate",       hex: "#4a5568", lab: [35.0, -1.0, -8.0]  },
  { name: "Warm Cream",  hex: "#f5f0e8", lab: [94.0, -0.5,  7.0]  },
  { name: "Off White",   hex: "#f8f8f6", lab: [97.0, -0.5,  1.5]  },
  { name: "Warm White",  hex: "#fdfaf5", lab: [98.0,  0.0,  3.0]  },
  { name: "Stone",       hex: "#c8b89a", lab: [74.0,  2.5, 14.0]  },
  { name: "Terracotta",  hex: "#c0614b", lab: [48.0, 30.0, 22.0]  },
  { name: "Forest",      hex: "#2d4a3e", lab: [28.0, -12.0, 5.0]  },
  { name: "Gold",        hex: "#b8941a", lab: [62.0,  4.0, 56.0]  },
  { name: "Charcoal",    hex: "#2d2d2d", lab: [18.0,  0.0,  0.0]  },
];

/** Facet vocabulary — fixed labels per axis (makes facets filterable, not open-ended).
 *  Populated by AI extraction at backfill time; usable as brief builder constraints immediately. */
export const FACET_VOCABULARY: Record<string, string[]> = {
  mood:   ["crafted", "refined", "bold", "playful", "minimal", "heritage", "experimental"],
  layout: ["editorial", "full-bleed", "grid", "asymmetric", "magazine"],
  era:    ["contemporary", "timeless", "vintage", "futuristic"],
  sector: ["architecture", "luxury", "tech", "fashion", "food", "manufacturing", "cultural"],
};

/** Nearest swatch name for a given LAB triple — used to render human-readable colour names
 *  in search queries sent to Gemini when the corpus can't serve the colour filter. */
export function labSwatchName(lab: [number, number, number]): string {
  let best = LAB_SWATCHES[0];
  let bestD = Infinity;
  for (const s of LAB_SWATCHES) {
    const d = Math.sqrt(
      Math.pow(s.lab[0] - lab[0], 2) +
      Math.pow(s.lab[1] - lab[1], 2) +
      Math.pow(s.lab[2] - lab[2], 2)
    );
    if (d < bestD) { bestD = d; best = s; }
  }
  return best.name;
}

/** Serialise active brief filters into a natural-language addendum for Gemini web search.
 *  e.g. "dark blue palette, crafted mood, editorial layout, contemporary era" */
export function filtersToQueryAddendum(filters: {
  colorLab?: [number, number, number] | null;
  facets?: Record<string, string[]>;
  color?: string;
}): string {
  const parts: string[] = [];
  if (filters.colorLab) parts.push(`${labSwatchName(filters.colorLab)} palette`);
  else if (filters.color) parts.push(`${filters.color} palette`);
  if (filters.facets) {
    for (const [axis, labels] of Object.entries(filters.facets)) {
      if (labels.length) parts.push(`${labels.join(" or ")} ${axis}`);
    }
  }
  return parts.join(", ");
}

/** Map existing tag strings to facet labels — enables stub facet population without AI.
 *  A tag may fire multiple facets. */
const TAG_TO_FACETS: Array<{ pattern: RegExp; facet: string; label: string }> = [
  { pattern: /\b(craft|handcraft|artisan|bespoke|handmade)\b/i, facet: "mood", label: "crafted" },
  { pattern: /\b(heritage|traditional|classic|historical)\b/i,  facet: "mood", label: "heritage" },
  { pattern: /\b(refin|sophist|elegant|premium|luxury|high.end)\b/i, facet: "mood", label: "refined" },
  { pattern: /\b(modern|contemporary|clean|minimal|minimalist)\b/i, facet: "mood", label: "minimal" },
  { pattern: /\b(bold|strong|impactful|dramatic|striking)\b/i,  facet: "mood", label: "bold" },
  { pattern: /\b(playful|fun|whimsical|creative|experimental|avant)\b/i, facet: "mood", label: "playful" },
  { pattern: /\b(editorial|magazine|editorial.layout)\b/i,      facet: "layout", label: "editorial" },
  { pattern: /\b(full.bleed|fullbleed|immersive)\b/i,           facet: "layout", label: "full-bleed" },
  { pattern: /\b(grid|modular|systematic)\b/i,                  facet: "layout", label: "grid" },
  { pattern: /\b(contemporary|current|today|now)\b/i,           facet: "era", label: "contemporary" },
  { pattern: /\b(timeless|classic|endur)\b/i,                   facet: "era", label: "timeless" },
  { pattern: /\b(vintage|retro|nostalgic|archive)\b/i,          facet: "era", label: "vintage" },
  { pattern: /\b(future|futurist|speculative|sci.fi)\b/i,       facet: "era", label: "futuristic" },
  { pattern: /\b(architect|studio|spatial|build|interior)\b/i,  facet: "sector", label: "architecture" },
  { pattern: /\b(luxury|premium|high.end|jewel|watch|haute)\b/i, facet: "sector", label: "luxury" },
  { pattern: /\b(tech|digital|saas|software|startup)\b/i,       facet: "sector", label: "tech" },
  { pattern: /\b(fashion|apparel|clothing|wear|style)\b/i,      facet: "sector", label: "fashion" },
  { pattern: /\b(food|restaur|gastro|culinary|drink|beverage)\b/i, facet: "sector", label: "food" },
  { pattern: /\b(manufactur|industry|industrial|craft.goods)\b/i, facet: "sector", label: "manufacturing" },
  { pattern: /\b(museum|gallery|cultural|art|exhibit)\b/i,       facet: "sector", label: "cultural" },
];

/** Derive facets from existing tag + caption strings (no AI required).
 *  Returns a partial facets record — only axes where at least one label fires. */
export function inferFacetsFromText(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { pattern, facet, label } of TAG_TO_FACETS) {
    if (pattern.test(text)) {
      if (!out[facet]) out[facet] = [];
      if (!out[facet].includes(label)) out[facet].push(label);
    }
  }
  return out;
}
