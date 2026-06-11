export type ItemType = "image" | "site" | "link" | "note";

export interface Library {
  id: string;
  user_id: string;
  name: string;
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
  ai_caption: string | null;
  stack_id: string | null;
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
  board_x: number | null;
  board_y: number | null;
  board_w: number | null;
  created_at: string;
}

export interface LinkMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  domain: string;
}
