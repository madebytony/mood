# Typography Discovery Feature Spec

Version: v1.0
Date: 2026-06-11
Owner: Product + Engineering
Status: Draft for implementation

## 1) Problem
Designers discover type in three different ways, but most tools only support one:
- Foundry-first: browsing releases and specimen pages
- Font-first: searching for a specific family and style
- Context-first: seeing typography in real use and asking "what font is this?"

Mood already captures and ranks visual references well. The gap is a structured, type-specific discovery surface that can move between these three discovery paths without losing curation quality.

## 2) Product Goal
Create a typography-led feature area where users can:
- Discover and save high-quality foundries and releases
- Build a reusable knowledge graph of Foundry -> Font -> In Use
- Search by typographic language (for example: geometric grotesque, high-contrast serif, editorial mono)
- Start from a screenshot and identify likely fonts with confidence scoring

## 3) Non-goals
- No font file hosting or font licensing transactions
- No broad marketplace indexing of low-quality free-font sites
- No OCR-heavy long-form document extraction
- No attempt to guarantee legal usage rights from discovered links

## 4) Users and Core Jobs
Primary user: visual designer / brand designer / art director.

Core jobs:
- "Show me foundries that match this typographic mood."
- "Show me fonts similar to this style."
- "I saw this in-use screenshot. What font might it be?"
- "Where can I license or learn about this font?"

## 5) Information Architecture
Top-level feature area: Typography (library mode)

Entity hierarchy:
- Foundry
- Font
- In Use

Navigation model:
- Typography Home -> Foundries feed
- Foundry detail -> linked fonts + notable in-use examples
- Font detail -> styles, metadata, specimen links, in-use gallery
- In-use detail -> probable font matches + confidence + source credits

## 6) Domain Model (strict)
### 6.1 Entity: Foundry
Fields:
- id (uuid)
- canonical_domain (unique)
- name
- website_url
- hq_country (optional)
- founded_year (optional)
- tags (array)
- quality_score (0-1)
- created_at, updated_at

Rules:
- Dedupe key is canonical_domain
- quality_score below threshold is hidden from default discovery

### 6.2 Entity: Font
Fields:
- id (uuid)
- foundry_id (fk Foundry)
- family_name
- slug (family_name normalized + foundry)
- classification (serif, sans, display, script, mono, variable)
- sub_style_tags (array)
- release_year (optional)
- variable_axis (array, optional)
- specimen_url
- buy_url (optional)
- license_notes (optional)
- confidence_profile (json)
- created_at, updated_at

Rules:
- Dedupe key is slug
- If foundry_id unknown, font can exist as provisional and be backfilled later

### 6.3 Entity: InUse
Fields:
- id (uuid)
- source_url
- source_domain
- image_item_id (fk items.id)
- context_type (editorial, web, poster, packaging, brand, app, other)
- notes
- created_at, updated_at

Rules:
- Dedupe key is normalized source_url or image perceptual hash

### 6.4 Relationship: inuse_font_match
Fields:
- in_use_id (fk InUse)
- font_id (fk Font)
- confidence (0-1)
- evidence (json)
- is_primary (bool)
- created_at

Rules:
- Keep top 5 candidates per in-use item
- At most one primary candidate

## 7) Library and Space Mode
Add mode support so behavior can be routed cleanly.

Schema additions:
- libraries.mode enum: design, type (default design)
- spaces.mode enum optional override: inherit, design, type (default inherit)

Routing behavior:
- If effective mode is type:
  - discover uses mode=type
  - captioning uses kind=type
  - search uses type-aware feature blending (caption + tags + fonts)

## 8) Ingestion and Enrichment Pipeline
### 8.1 Input channels
- Foundry URL capture
- Font specimen URL save
- In-use image upload or URL save

### 8.2 Capture step
Reuse existing capture pipeline for screenshots and metadata.

### 8.3 Classification step
Classifier predicts item role:
- foundry_page
- font_specimen
- in_use
- unknown

### 8.4 Extraction step
Extract:
- probable foundry names
- probable font family names
- typographic descriptors
- evidence snippets (text OCR, page metadata, visual cues)

### 8.5 Entity linker
- Resolve to existing Foundry/Font when confidence passes threshold
- Otherwise create provisional entities
- Store all evidence for later review

## 9) Font Identification Confidence Model
Confidence should be explicit and reviewable.

Score formula:
- total = 0.35 * visual_match + 0.30 * textual_match + 0.20 * source_reliability + 0.15 * co_occurrence_prior

Component definitions:
- visual_match: shape-level model confidence from screenshot
- textual_match: OCR or metadata hit on font/foundry names
- source_reliability: curated source trust score
- co_occurrence_prior: historical association frequency in your corpus

Thresholds:
- >= 0.82: auto-link as primary candidate
- 0.62 to 0.81: store as candidate, requires review
- < 0.62: keep as weak hint only

## 10) Discovery and Ranking
Candidate pools for Typography Home:
- curated seeds (foundries)
- Are.na type channels
- grounded web search constrained to quality domains
- user graph expansion from liked/saved entities

Ranking objectives:
- maximize typographic relevance
- keep novelty high
- suppress aggregators and low-signal directories

Ranking blend:
- 45% user taste match (tags + caption embeddings + fonts)
- 25% quality score
- 20% novelty/diversity
- 10% recency (new releases)

Diversity guardrails:
- max 2 results per domain in top 20
- ensure at least 5 unique foundries in first 12 cards

## 11) Search Behavior
Search input types:
- descriptor query: "geometric grotesque editorial"
- entity query: "sharp type", "ohno"
- intent query: "fonts like this screenshot"

Retrieval stack:
- lexical match over title/tags/fonts/domains
- semantic vector match over type-aware captions
- graph expansion via linked entities

Result sections:
- Foundries
- Fonts
- In Use

## 12) Curation and Review UX
Manual actions:
- Confirm font match
- Reject font match
- Set primary font for an in-use item
- Merge duplicate font entities
- Merge duplicate foundries

Review queue:
- show candidates in 0.62 to 0.81 confidence band
- one-tap approve/reject with keyboard shortcuts

## 13) API Surface
Existing endpoints to keep:
- GET /api/discover with mode=type
- POST /api/ai/caption with kind=type

New endpoints:
- POST /api/type/classify
  - input: item id or image url
  - output: role + confidence
- POST /api/type/identify
  - input: in-use item id
  - output: candidate fonts + evidence + confidence
- GET /api/type/foundries
  - filters: query, tags, quality, page
- GET /api/type/fonts
  - filters: foundry_id, query, classification, tags
- GET /api/type/in-use
  - filters: font_id, context_type, query
- POST /api/type/match/review
  - input: in_use_id, font_id, action approve/reject/set_primary

## 14) Data Quality and Governance
Quality controls:
- source allow/block list for discovery
- per-domain trust score
- duplicate detection jobs for foundry/font entities
- stale link checker inherited from existing item flow

Attribution and legal:
- retain source_url and source_domain for every in-use record
- show source link and foundry link prominently
- include "font identification is probabilistic" disclosure

## 15) Metrics
Activation:
- percent of users creating a type-mode library
- percent saving at least 3 type entities in first week

Core quality:
- save rate from typography feed
- accepted match rate in review queue
- search success rate (save within 3 result clicks)

Retention:
- weekly returning users in type-mode libraries
- repeat usage of "find more" in typography feed

Guardrail:
- percent of low-quality domains shown in top 20
- manual rejection rate of auto-linked matches

## 16) Rollout Plan
Phase 1 (1-2 weeks): Mode wiring + type-aware captioning in production paths
- Wire mode and kind routing
- Include fonts in search and embeddings
- No new UI primitives required

Phase 2 (2-3 weeks): Entity graph foundation
- Add Foundry, Font, InUse tables and match table
- Build linker and review queue API

Phase 3 (2-4 weeks): Dedicated typography UX
- Typography Home sections and filters
- Foundry detail and font detail pages/panels
- In-use match confidence UI

Phase 4 (ongoing): Ranking and quality tuning
- trust scoring
- diversity constraints
- threshold tuning using review outcomes

## 17) Acceptance Criteria
MVP acceptance:
- In a type-mode space, discover returns type candidates only
- New captures in type-mode use type caption prompts
- Search for a known foundry/font name returns matching saved items
- Detail view shows extracted font data where available

Graph acceptance:
- Each in-use item stores up to 5 candidate fonts with confidence
- Reviewer can approve/reject candidates and set primary in < 3 clicks
- Duplicate foundry/font entities can be merged without data loss

Quality acceptance:
- Top 20 typography feed includes at least 80% high-quality type sources
- Auto-link precision for >= 0.82 confidence is at least 85% on reviewed sample

## 18) Implementation Mapping to Current Code
Primary touchpoints in current repo:
- discovery route: src/app/api/discover/route.ts
- caption route: src/app/api/ai/caption/route.ts
- app data layer: src/lib/db.ts
- feed UI: src/components/Feed.tsx
- page orchestration: src/app/page.tsx
- existing font display in detail panel: src/components/Detail.tsx

## 19) Open Questions
- Should mode be library-level only, or space-level override too?
- Should provisional fonts be visible to users before review?
- Should "in-use" allow multiple confirmed primary fonts for multi-face layouts?
- Do we need a source trust editorial tool in admin, or start with static config?

## 20) Immediate Next Decision
Pick one of these to execute first:
- A) implement phase 1 wiring now
- B) create database migration for mode and entity tables
- C) prototype review queue UI for candidate matches
