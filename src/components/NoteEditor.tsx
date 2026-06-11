"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { CARD_TINTS, TEXT_COLORS } from "@/lib/cardColors";

interface Props {
  /** Initial HTML (or legacy plain text — caller should pre-wrap). */
  html: string;
  onChange: (html: string) => void;
  /** Called on blur/unmount so the parent can persist + leave edit mode. */
  onBlur?: (html: string) => void;
  autoFocus?: boolean;
  /** Optional card-tint controls shown as a strip above the editor. */
  cardColor?: string | null;
  onCardColor?: (key: string | null) => void;
}

const btn = "grid h-7 w-7 place-items-center rounded-md text-zinc-300 hover:bg-white/10";
const btnOn = "bg-white/15 text-white";

function Toolbar({ editor }: { editor: Editor }) {
  // useEditorState would be ideal, but reading isActive directly is fine inside BubbleMenu
  // which only re-renders while visible.
  const is = (name: string, attrs?: Record<string, unknown>) => editor.isActive(name, attrs);
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-white/10 bg-[#1e1e26] p-1 shadow-xl">
      <button className={`${btn} ${is("bold") ? btnOn : ""}`} title="Bold"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}>
        <b>B</b>
      </button>
      <button className={`${btn} ${is("italic") ? btnOn : ""}`} title="Italic"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <i>I</i>
      </button>
      <button className={`${btn} ${is("underline") ? btnOn : ""}`} title="Underline"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <u>U</u>
      </button>
      <span className="mx-0.5 h-4 w-px bg-white/10" />
      <button className={`${btn} ${is("heading", { level: 1 }) ? btnOn : ""}`} title="Heading 1"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <span className="text-xs font-bold">H1</span>
      </button>
      <button className={`${btn} ${is("heading", { level: 2 }) ? btnOn : ""}`} title="Heading 2"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <span className="text-xs font-bold">H2</span>
      </button>
      <span className="mx-0.5 h-4 w-px bg-white/10" />
      <button className={`${btn} ${is("bulletList") ? btnOn : ""}`} title="Bullet list"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        •
      </button>
      <button className={`${btn} ${is("orderedList") ? btnOn : ""}`} title="Numbered list"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <span className="text-xs">1.</span>
      </button>
      <button className={`${btn} ${is("taskList") ? btnOn : ""}`} title="Checklist"
        onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        ☑
      </button>
      <span className="mx-0.5 h-4 w-px bg-white/10" />
      <button className={`${btn} ${is("link") ? btnOn : ""}`} title="Link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const prev = editor.getAttributes("link").href as string | undefined;
          const url = window.prompt("Link URL", prev ?? "https://");
          if (url === null) return;
          if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
          editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }}>
        🔗
      </button>
      <span className="mx-0.5 h-4 w-px bg-white/10" />
      {TEXT_COLORS.map((c) => (
        <button
          key={c.label}
          title={`Text: ${c.label}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => c.value ? editor.chain().focus().setColor(c.value).run() : editor.chain().focus().unsetColor().run()}
          className="grid h-7 w-5 place-items-center"
        >
          <span
            className="h-3.5 w-3.5 rounded-full border border-white/20"
            style={{ background: c.value || "transparent" }}
          />
        </button>
      ))}
    </div>
  );
}

export default function NoteEditor({ html, onChange, onBlur, autoFocus, cardColor, onCardColor }: Props) {
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last HTML we actually persisted so the unmount flush only saves real changes.
  const lastSaved = useRef(html);

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      }),
      TextStyle,
      Color,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "Write something…" }),
    ],
    content: html || "",
    editorProps: { attributes: { class: "note-prose min-h-[2rem] outline-none" } },
    onUpdate: ({ editor }) => {
      if (debounce.current) clearTimeout(debounce.current);
      const out = editor.getHTML();
      debounce.current = setTimeout(() => { lastSaved.current = out; onChange(out); }, 350);
    },
  });

  // On unmount: flush the latest HTML (the debounce timer would otherwise be cleared unsaved),
  // so closing the note right after formatting still persists the change.
  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      if (!editor) return;
      const out = editor.getHTML();
      if (out !== lastSaved.current) { lastSaved.current = out; onChange(out); }
      onBlur?.(out);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="flex h-full flex-col">
      {onCardColor && (
        <div className="mb-1.5 flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          {CARD_TINTS.map((t) => (
            <button
              key={t.key}
              title={t.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onCardColor(cardColor === t.key ? null : t.key)}
              className={`h-4 w-4 rounded-full ${t.swatch} ${cardColor === t.key ? "ring-2 ring-white/80 ring-offset-1 ring-offset-transparent" : "opacity-70 hover:opacity-100"}`}
            />
          ))}
          {cardColor && (
            <button
              title="No colour"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onCardColor(null)}
              className="ml-0.5 grid h-4 w-4 place-items-center rounded-full border border-white/25 text-[10px] text-zinc-400 hover:text-white"
            >×</button>
          )}
        </div>
      )}
      <BubbleMenu editor={editor}>
        <Toolbar editor={editor} />
      </BubbleMenu>
      <div className="min-h-0 flex-1 overflow-y-auto" onPointerDown={(e) => e.stopPropagation()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
