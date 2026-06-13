# Mood — Discovery v3 Build Plan

_A plan to rebuild and supercharge how the app discovers, ranks, and surfaces design work.
Written to be executed phase by phase (each phase is independently shippable)._

---

## 0. The reframe

Today the engine is a **convergent taste retriever**: nearly every path ranks by cosine distance
to a taste centroid, and the strong visual judge only runs on the image-reference "more like this"
path. It is great at *deepening* and weak at *discovery* — the entry point is stale, text-ranked,
and an echo chamber.

v3 reframes discovery as a proper **recommender pipeline**:

```
                ┌─────────────┐   ┌──────────┐   ┌───────────┐   ┌─────────────┐
 sources ─────▶ │ CANDIDATE   │──▶│ RERANK   │──▶│ DIVERSIFY │──▶│ POLICY MIX  │──▶ feed
 (harvest)      │ GENERATION  │   │ (visual+ │   │  (MMR /   │   │ fresh / for │
                │ vector+kw+  │   │  rerank) │   │  de-clump)│   │ you/explore │
                │ colour+recency  └──────────┘   └───────────┘   └─────────────┘
                └─────────────┘
                       ▲                                                │
                       │              learning loop (events) ◀──────────┘
                  facets + colour + trend signals
```

Four design principles:

1. **Candidate generation is plural** — vector ∪ keyword/tags ∪ colour ∪ recency ∪ trending, fused
   (RRF), not a single cosine query.
2. **The best machinery runs on every path** — visual/aesthetic verification and colour-matching
   are not gated to the image-similar path.
3. **The feed has a policy** — explicit fresh / for-you / explore mix, recency-aware, diversified,
   instead of "nearest centroid, every time."
4. **Everything is faceted and explainable** — palette, type, layout, motion, mood, era, material,
   sector are structured signals, so briefs become constraints and matches carry "why" chips.

---

## 1. Foundational unlocks (do these first — everything else leans on them)

### 1A. Get embeddings off the rate-limit cliff  ★ highest leverage
The Voyage free tier (3 RPM) is why we *can't* embed every candidate, which is why retrieval is
forced back onto curated-source text-rank. Fixing this unlocks visual retrieval everywhere.

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| **Self-host SigLIP / OpenCLIP** (Modal, Replicate, Cloudflare Workers AI, or own GPU) | no rate limit, cheap at volume, image+text in one space, batchable | infra to run; 768–1152-dim vs Voyage 1024 → re-embed corpus | **Primary.** SigLIP-2 or OpenCLIP ViT-L. Batch the whole corpus nightly. |
| **Paid Voyage tier** | drop-in, keeps current vectors | $$, still API-bound, multimodal quota | Fallback / hybrid. |
| **Cloudflare Workers AI embeddings** | cheap, edge, generous limits | model choice narrower | Good budget option. |

**Action:** introduce an `Embedder` interface (`embedImage`, `embedText`, `embedHybrid`) with a
provider behind it, so we can swap Voyage → SigLIP without touching call sites. Re-embed `web_corpus`
and `items` into a new `embedding_v2` column; migrate `match_*` RPCs to it; drop the old column once
parity is confirmed.

### 1B. Add a dedicated reranker
LLM-text-pick (`rank()`) is the weakest link. Replace/augment with a cross-encoder reranker over the
top ~100 candidates.

- **Voyage `rerank-2`** or **Cohere `rerank-3`** (text: title+tags+facets vs brief) — cheap, fast.
- For visual rerank, keep the Gemini/Claude judge but feed it a *pre-reranked* shortlist so it spends
  tokens only on plausible candidates (we already prerank by cosine; add the reranker as a second stage).

### 1C. Structured facet extraction (the taste taxonomy)  ★ unblocks scenario 1
Replace free-text-only tags with a controlled, extracted facet set per item/corpus row:

```
facets jsonb := {
  palette_named: ["dark-blue","slate","cream"],
  palette_lab:   [[L,a,b], ...],          // for delta-E matching
  type_style:    ["grotesque","display-serif"],
  layout:        ["editorial","full-bleed","grid"],
  motion:        ["scroll-reveal","webgl","static"],
  mood:          ["crafted","heritage","refined","modern"],
  era:           ["contemporary","timeless"],
  material:      ["wood","glass","metal","paper-texture"],
  sector:        ["architecture","manufacturing","luxury-goods"]
}
```

Extracted by a vision model (Gemini Flash for cost, Claude for the hard ones) at harvest/caption time,
against a **fixed vocabulary** (so facets are filterable, not open-ended). This is what turns
"dark blue, craftsmanship, heritage, modern" into hard + soft constraints with explainable matches.

### 1D. A real colour engine
We already store named buckets. Add **CIELAB + delta-E** so "dark blue" means dark blue, not "blue-ish."
- Store `palette_lab` per item/corpus row (dominant 3–5 colours, k-means in LAB).
- Colour match = min delta-E to the target swatch(es) + harmony scoring (analogous/complementary).
- Powers: colour-filtered briefs, colour facet chips, "same palette, different layout" pivots.

### 1E. Multi-model AI strategy (use the right model per job)
- **Triage / validity / facet-tagging:** Gemini Flash (cheap, high volume) — already in place; extend.
- **Aesthetic judgment / final rerank:** **Claude (Sonnet/Opus vision)** for nuanced taste calls and
  brief reasoning; Gemini for grounded web search. A/B them on a labelled set.
- **Brief expansion / agentic search:** Claude as a planner (see §4).
- **Embeddings:** SigLIP/Voyage (§1A). **Rerank:** Voyage/Cohere (§1B).
- Wrap each behind a thin interface so models are swappable and A/B-able; log which model produced
  each ranking for evaluation.

---

## 2. Data model changes

```sql
-- web_corpus / items: add
embedding_v2   vector(1152)        -- new embedder space
facets         jsonb               -- §1C
palette_lab    jsonb               -- §1D
first_seen_at  timestamptz         -- recency
trend_score    real default 0      -- §3, recomputed by cron
style_cluster  int                 -- §5 auto-lanes

-- new: signals for the learning loop + trending
create table discovery_events (
  id bigserial primary key,
  user_id uuid, url text, item_id uuid,
  kind text,           -- impression | open | save | like | dislike | dwell_ms
  value real,          -- dwell ms etc
  lane text, ref_key text, model text,   -- attribution
  created_at timestamptz default now()
);

-- new: named style clusters (auto-generated lanes)
create table style_clusters ( id int primary key, label text, centroid vector(1152), size int );
```

New/updated RPCs: `match_corpus_v2` (cosine on v2 + optional recency decay + facet/colour filters),
`hybrid_search` (RRF over vector + keyword + colour), `trending_corpus` (by `trend_score`),
`fresh_corpus` (by `first_seen_at`).

---

## 3. Retrieval & feed policy (the heart of the fix)

### 3A. Candidate generation — hybrid, fused
For any request, gather candidates from several retrievers and fuse with **Reciprocal Rank Fusion**:
- **Vector** (taste centroid / reference / brief embedding)
- **Keyword/facet** (tags + facet match; Postgres FTS or BM25)
- **Colour** (delta-E to target palette, when set)
- **Recency** (`fresh_corpus`)
- **Trending** (`trending_corpus`)
RRF needs no score calibration across retrievers and is robust. Output: a deduped candidate pool.

### 3B. Rerank
Two-stage: reranker (§1B) over the pool → top N → sampled visual/aesthetic judge (§1E) on the head.
Cache verdicts (we already have judge-verdict memory; generalise it).

### 3C. Diversify
**MMR** (maximal marginal relevance) or a per-facet/per-domain cap so one foundry-direct batch or one
palette can't dominate a feed slice. Tunable diversity weight per lane (Explore = high, For You = low).

### 3D. Policy mix — the lanes
Replace the single browse feed with an explicit blend:

| Lane | Source policy | Answers |
|---|---|---|
| **Fresh / This week** | `fresh_corpus` + live galleries, recency-ranked, *centroid-free* | "what's hot" (scenario 2 entry) |
| **For You** | taste model + RRF, low diversity | "more of what I love" |
| **Explore** | far-from-centroid + random style clusters + bandit picks, high diversity | serendipity / breaks echo chamber |
| **Style clusters** | auto-named clusters (§5), browseable | topic discovery (Pinterest-like) |
| **Palette / facet filters** | hard filters over any lane | scenario 1 constraints |

Default Home = a **woven** feed (e.g. 1 fresh : 2 for-you : 1 explore) with a **multi-armed bandit**
(Thompson sampling) over lanes/clusters learning from `discovery_events`. Never fully bypass live
galleries (kill the `corpus.length >= 10` short-circuit).

### 3E. Recency & trending
- Time-decay the vector score (`score * exp(-age/τ)`) in `match_corpus_v2`.
- `trend_score` = save/like velocity across users (or, single-user, your own engagement + new-arrival
  velocity per cluster), recomputed by the daily cron. Drives a "Rising" lane.

---

## 4. Brief mode — scenario 1 (window company: contemporary, dark-blue, craft + heritage)

A first-class **structured brief builder**, not just a text box:
- **Palette picker** (swatches → target `palette_lab`), **facet chips** (mood: crafted/heritage;
  era: contemporary; layout; motion), plus free text.
- **Agentic expansion (Claude):** expand the brief into multiple search facets, synonyms, *and
  cross-domain reference brands* — e.g. "window company" → fenestration/joinery/architectural-glazing
  brands **and** heritage-craft tone references (luxury watchmaking, bespoke furniture) so the tone is
  matched even from other sectors. (Reuse the deep-research harness pattern: plan → multi-query search
  → fetch → judge → iterate.)
- **Colour-verified results:** post-filter candidates by delta-E to the dark-blue target; show a
  colour chip on each (matched/near/off).
- **In-context controls:** surface palette chips + lanes **inside the Explore/Similar dialog**
  (currently hidden behind `compact` in `Feed.tsx`) so constraints can be tightened without re-typing.
- **Explainable matches:** "dark-blue palette ✓ · editorial layout ✓ · heritage mood ✓" per result.
- **Save-to-board → board becomes the brief:** board facet profile (not just centroid) drives
  "find more like this board" using *multiple* reference images, not one rep thumb.

Acceptance test: type/build the window brief → ≥70% of top 12 results are genuinely dark-blue
(delta-E verified), design-led, and a mix of in-sector + tonal cross-sector; refining the palette chip
visibly tightens colour.

---

## 5. Deepen loop — scenario 2 (rabbit-hole)

Keep the visual judge (the crown jewel) and add:
- **"Less like this"** (negative signal) and **facet pivots**: "same palette / different layout",
  "same mood / lighter", "more experimental". One-tap lateral moves.
- **Multi-reference search:** judge against the top-k board images, not one rep thumb.
- **Session rabbit-hole detection:** within a session, weight the bandit toward the cluster you're
  engaging with (lean in); reset toward Fresh/Explore on a new session.
- **Auto style clusters (§3D):** k-means the corpus embeddings → name each cluster with Claude
  ("warm editorial", "techno-brutalist", "swiss minimal") → browseable lanes + "you keep saving from
  *warm editorial*" nudges.

Acceptance test: open a striking site → "more like this" returns visually-coherent matches → saving
3–4 measurably shifts the next "find more" and the For-You lane toward that style within the session.

---

## 6. Taste model upgrade
Move beyond a single centroid:
- Use saves as **positive** and dislikes/skips as **negative** examples → a lightweight
  preference model in embedding space (logistic regression / linear SVM, or a small two-tower).
  Output: a taste direction *and* a margin, per board.
- Per-board profiles (already scoped by space) get a facet histogram + palette profile, not just a
  centroid — so "warm editorial board" and "brutalist board" stay clean and explainable.

---

## 7. Sources — broaden and freshen
Group harvesters by role; run on the cron with per-source budgets.

- **Real-time "hot":** Awwwards SOTD, CSS Design Awards, FWA, Godly latest, httpster monthly,
  Land-book new, Typewolf SOTD (have), Sidebar.io daily links.
- **Curated mood graphs:** Are.na (have) — add a **graph walk** (follow connected channels & block
  connections) for depth; Cosmos.so, Savee.it, Designspiration.
- **Editorial / journalism:** It's Nice That (have), Brand New (UnderConsideration), Identity Designed,
  Fonts In Use (have).
- **Brand & agency work (for briefs):** agency case-study pages (have a seed list — expand), plus
  sector coverage so industry briefs (window co., etc.) have in-sector exemplars.
- **Quality controls:** keep the SOCIAL/DEV/CURATION filters + capture vetting + hygiene; add a
  per-source quality prior (sources earn trust from save-through rate).

Principle: harvest for **breadth** (the index should over-cover the aesthetic space); let the feed
*policy* decide breadth-vs-taste, not the harvester.

---

## 8. Quality gates everywhere
- Run the **validity gate** (already built) and a **sampled aesthetic/colour check** on the *head* of
  every feed path (browse, brief), not just image-similar. With §1A embeddings this is affordable.
- Keep capture vetting + corpus hygiene as the backstops.
- Display: prefer real screenshots; flag/repair mShots wobble proactively (hygiene already does — make
  it eager for newly-shown rows).

---

## 9. Observability & learning loop
- Log `discovery_events` (impression/open/save/like/dislike/dwell) with lane + model attribution.
- Nightly job: recompute `trend_score`, bandit posteriors, taste models, style clusters.
- A small **eval harness**: a labelled set of (brief → good/bad results) and (reference → match/no) to
  A/B models and ranking changes. This is how "is it quality?" becomes measurable, not vibes.

---

## 10. UX surface map
- **Home:** lane switcher (Fresh · For You · Explore · Clusters) + persistent palette/facet filter bar
  (everywhere, including the brief dialog). Woven default feed.
- **Result card:** "why" chips (palette/layout/mood matched), save, more-like, less-like, facet pivots.
- **Brief builder:** palette + facet + text, agentic search, colour-verified faceted results.
- **Boards:** facet profile, multi-reference "explore style", negative signals.
- **Digest:** weekly "new in your lanes / rising in *warm editorial*" (in-app + optional email/push).

---

## 11. Phased roadmap

Each phase is shippable and independently valuable. Acceptance tests in §4/§5.

**Phase 0 — Foundations (unblocks everything)**
- §1A Embedder interface + SigLIP self-host; re-embed corpus to `embedding_v2`; `match_*_v2`.
- §2 schema (facets, palette_lab, recency, events, clusters).
- §9 event logging (start collecting immediately — the learning loop needs history).

**Phase 1 — Feed policy + freshness (biggest scenario-2 win)**
- §3 hybrid candidate gen (RRF) + recency decay + MMR diversity.
- §3D lanes: Fresh, For You, Explore; kill the corpus≥10 bypass; bandit v1.
- §1B reranker in the pipeline.

**Phase 2 — Facets + colour + brief mode (biggest scenario-1 win)**
- §1C facet extraction (backfill corpus + items) + §1D colour engine (LAB/delta-E).
- §4 structured brief builder + agentic expansion + colour-verified faceted results.
- Surface palette/facet controls in the compact dialog.

**Phase 3 — Taste model, clusters, deepen loop, digests**
- §6 preference model; §5 style clusters + auto-lanes; less-like / facet pivots; multi-reference
  board search; §10 weekly digest.

**Phase 4 — Quality everywhere + eval harness**
- §8 sampled aesthetic/colour gate on all paths; §9 eval harness + model A/B; tune bandit & decay.

---

## 12. Decisions to make before Phase 0
1. **Embedding infra:** self-host SigLIP (recommended) vs paid Voyage vs Cloudflare — sets cost/latency
   and whether we re-embed.
2. **Judge/brief model:** Claude vs Gemini for aesthetic judgment & brief reasoning (recommend Claude
   for judgment, Gemini for grounded search) — A/B in Phase 4.
3. **Budget appetite:** how much monthly spend for embeddings/rerank/vision at the corpus size you
   want (drives self-host vs API).
4. **Single-user vs multi-user trending:** trend signal is richer with multiple users; single-user
   relies on your own velocity + new-arrival rate.
5. **Scope of agentic brief search:** lightweight query-expansion vs full deep-research loop per brief
   (cost vs depth).

---

## 13. What changes for the two scenarios

| | Today | After v3 |
|---|---|---|
| **Window-co. brief** | text box → Gemini web search; "dark blue" unverified; no controls in dialog | structured brief + agentic expansion + delta-E colour verification + in-dialog palette/facet filters + explainable matches |
| **Pinterest rabbit-hole** | stale centroid feed at entry; strong deepen loop | Fresh + Explore lanes + bandit for the entry; same strong deepen loop + less-like / facet pivots + auto style clusters |

---

## 14. Mobile-first (cross-cutting — not a phase)

This is used primarily on a phone. Every phase ships mobile-first, not desktop-retrofitted.

- **Feed layout:** the discovery grid must be a tight, scannable masonry on a ~380px viewport — a
  capped card aspect ratio (not full-height screenshots), 2 columns, lazy images, skeletons. Today
  cards render at full screenshot height → ~1.5 cards per screen (see live diagnostics §16).
- **Controls reachable by thumb:** lane switcher + palette/facet filters as a sticky, horizontally
  scrollable bar; brief builder works one-handed; bottom-sheet pickers (already the pattern for "Save
  to…").
- **PWA quality:** installed to home screen, offline-tolerant feed (cache last view), fast first paint;
  respect safe-area insets (already partly done).
- **Capture from the phone is a primary flow** (see §15) — share-sheet must be reliable, not a fragile
  manual Shortcut.
- **Perf budget:** signed-URL batching, image sizes tuned for mobile bandwidth, virtualised long feeds.

## 15. Capture & ingest (share sheet / Shortcut / extension / PWA)

Saving from the phone must be frictionless and **never silently drop**.

- **Graceful degrade, never vanish:** a fire-and-forget capture (Shortcut/extension) that can't get a
  clean screenshot must fall back to saving a **link/bookmark card** (URL + title), not nothing and not
  a 404 tile. (Interactive in-app capture keeps the 422 + visible error.) This is the key fix for
  "runs but nothing saves."
- **Robustness:** the clip route must be import-safe (a capture-pipeline dependency must not be able to
  500 the whole route, including image clips) and return structured outcomes the Shortcut/extension can
  branch on.
- **Confirmation:** the Shortcut should surface real success/failure (it currently shows "Saved ✓"
  regardless of HTTP status). Consider a server-rendered confirmation or a Shortcut that checks status.
- **Replace the fragile manual Shortcut** with a hardened "Image to Mood"/"Page to Mood" pair (or a
  signed deep link / PWA share-target) so image vs page is unambiguous and the payload is correct.
- **Native share-target (PWA):** register a Web Share Target so "Share → Mood" works without a Shortcut.

## 16. Live diagnostics (2026-06-13)

Measured against the production DB to ground the above:

- **Embedding backlog: 625 / 1,970 corpus rows embedded (68% unembedded).** The feed only draws from
  the embedded slice; the rest of the harvested index is invisible to vector retrieval. Draining at
  Voyage's 3 RPM is ~7.5 h of continuous calls — **infeasible without §1A (self-hosted SigLIP/CLIP)**.
  This is the single biggest cause of the poor feed and the strongest reason §1A is priority #1.
- **Poison in the browse feed is real** (observed: logo-on-white, a "0" loading screen, a 404 page).
  The browse path has no quality gate (§8) and shows raw corpus og:images (only 10/1970 use mShots).
- **Captures work but stopped:** 50 images (latest 12th) + 31 site captures (latest 11th); **0 items
  saved on the 13th.** Image and page clips have both worked historically — so "not working" is a
  recent regression or a silent non-2xx, not a fundamentally broken path. Likely culprits: (a) a
  page-capture that now returns 422 on poison (fire-and-forget can't see it), or (b) the clip route
  failing to load if the capture pipeline's new deps don't initialise in its bundle. Both addressed by
  §15's graceful-degrade + import-safety.
