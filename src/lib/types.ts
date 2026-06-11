export type ItemType = "image" | "site" | "link" | "note" | "todo";
export type LibraryMode = "default" | "type";

export interface Library {
  id: string;
  user_id: string;
  name: string;
  mode?: LibraryMode | null;
  sort: number;
  created_at: string;
}

export interface Space {
  id: string;
  library_id: string;
  user_id: string;
  name: string;
  kind: "normal" | "inbox";
  view: "grid" | "board";
  sort: number;
  created_at: string;
}

export interface Item {
  id: string;
  space_id: string;
  user_id: string;
  type: ItemType;
  storage_path: string | null;
  thumb_path: string | null;
  /** For notes this holds rich-text HTML (legacy notes hold plain text); for todos, a JSON array. */
  content: string | null;
  title: string | null;
  source_url: string | null;
  source_domain: string | null;
  tags: string[];
  colors: string[];
  fonts: string[];
  tech: string[];
  width: number | null;
  height: number | null;
  board_x: number | null;
  board_y: number | null;
  board_w: number | null;
  /** Manual card height (notes/cards the user dragged taller); null = derive from content. */
  board_h: number | null;
  ai_caption: string | null;
  stack_id: string | null;
  stack_order: number | null;
  board_z: number | null;
  collapsed: boolean;
  /** Milanote-style card tint key (e.g. "amber", "blue"); null = default dark card. */
  card_color: string | null;
  /** Set true by a background reachability check when the source URL fails to load. */
  dead_link: boolean;
  created_at: string;
  last_viewed_at: string | null;
  /** Cosine similarity, present only on rows returned by the match_* RPCs. */
  similarity?: number;
}

export interface Stack {
  id: string;
  user_id: string;
  space_id: string;
  name: string;
  kind: "stack" | "column";
  board_x: number | null;
  board_y: number | null;
  board_w: number | null;
  board_z: number | null;
  /** Column minimised to just its header. */
  collapsed: boolean;
  created_at: string;
}

export interface LinkMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  domain: string;
}
