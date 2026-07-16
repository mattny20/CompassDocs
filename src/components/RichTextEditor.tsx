"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List as ListIcon,
  ListOrdered,
  TextQuote,
  Link as LinkIcon,
  Code as CodeIcon,
  SquareCode,
  ImagePlus,
  Mail,
} from "lucide-react";

// Starter content inserted by the "Email template" toolbar button. Rendered
// on document pages as a letter-style card with copy buttons (```email).
const EMAIL_STARTER = `Subject: 

Hi ,



Thanks,
`;

const TB_ICON = "h-4 w-4";

// Image with an author-chosen display width. The width is carried in the
// node's `title` attribute as "w=NN%", which tiptap-markdown serializes to
// standard `![alt](src "w=NN%")` — the same token MarkdownView renders.
const SizableImage = Image.extend({
  renderHTML({ node, HTMLAttributes }) {
    const m = /^w=(\d{1,3})%$/.exec(String(node.attrs.title ?? ""));
    return [
      "img",
      mergeAttributes(HTMLAttributes, m ? { style: `width:${Math.min(100, Number(m[1]))}%` } : {}),
    ];
  },
});

const IMAGE_SIZES: { label: string; title: string | null }[] = [
  { label: "S", title: "w=25%" },
  { label: "M", title: "w=50%" },
  { label: "L", title: "w=75%" },
  { label: "Full", title: null },
];

// A WYSIWYG editor for people who don't want to write Markdown. It reads and
// writes Markdown under the hood (via tiptap-markdown), so the stored content,
// search, export, and preview all stay Markdown — the same format the raw
// editor uses. Parent owns the Markdown string; this component just presents it.
export function RichTextEditor({
  value,
  onChange,
  onUploadImage,
}: {
  value: string;
  onChange: (markdown: string) => void;
  /** Upload an image file, resolving to its serving URL (null on failure). */
  onUploadImage?: (file: File) => Promise<string | null>;
}) {
  // Keep the latest callback in a ref so the editor (created once) always
  // calls the current closure — uploads depend on live parent state.
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;

  function insertUploaded(editor: Editor, file: File) {
    void uploadRef.current?.(file).then((url) => {
      if (!url) return;
      const alt = (file.name || "image").replace(/\.[a-z0-9]+$/i, "") || "image";
      editor.chain().focus().setImage({ src: url, alt }).run();
    });
  }

  function firstImage(items: DataTransferItemList | null): File | null {
    if (!items) return null;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    }
    return null;
  }
  const editor = useEditor({
    // Next.js renders this on the server first; defer creation to the client to
    // avoid a hydration mismatch.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      SizableImage,
      Markdown.configure({ html: false, linkify: true, breaks: true }),
    ],
    content: value,
    editorProps: {
      attributes: {
        // Reuse the app's document styling so editing looks like the rendered doc.
        class: "doc-prose min-h-[420px] px-5 py-4 focus:outline-none",
      },
      // Pasted or dropped screenshots upload as attachments and insert inline.
      handlePaste: (view, event) => {
        const file = firstImage(event.clipboardData?.items ?? null);
        if (file && uploadRef.current && editor) {
          event.preventDefault();
          insertUploaded(editor, file);
          return true;
        }
        return false;
      },
      handleDrop: (view, event) => {
        const file = firstImage(event.dataTransfer?.items ?? null);
        if (file && uploadRef.current && editor) {
          event.preventDefault();
          insertUploaded(editor, file);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.storage.markdown.getMarkdown());
    },
  });

  // Reflect external changes to `value` (mode switch, AI proofread "Apply")
  // without clobbering the cursor while the user is typing here.
  useEffect(() => {
    if (!editor) return;
    const current = editor.storage.markdown.getMarkdown();
    if (value !== current) {
      editor.commands.setContent(value, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) {
    return <div className="min-h-[420px] px-5 py-4 text-sm text-slate-400">Loading editor…</div>;
  }

  return (
    <div>
      <Toolbar
        editor={editor}
        onPickImage={onUploadImage ? (file) => insertUploaded(editor, file) : undefined}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({
  editor,
  onPickImage,
}: {
  editor: Editor;
  onPickImage?: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const promptLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev || "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-100 px-2 py-1.5">
      <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} label="Bold">
        <BoldIcon className={TB_ICON} />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} label="Italic">
        <ItalicIcon className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        label="Strikethrough"
      >
        <Strikethrough className={TB_ICON} />
      </Btn>
      <Divider />
      <Btn
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        label="Heading 1"
      >
        <Heading1 className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        label="Heading 2"
      >
        <Heading2 className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        label="Heading 3"
      >
        <Heading3 className={TB_ICON} />
      </Btn>
      <Divider />
      <Btn
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        label="Bulleted list"
      >
        <ListIcon className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        label="Numbered list"
      >
        <ListOrdered className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        label="Quote"
      >
        <TextQuote className={TB_ICON} />
      </Btn>
      <Divider />
      <Btn onClick={promptLink} active={editor.isActive("link")} label="Link">
        <LinkIcon className={TB_ICON} />
      </Btn>
      {onPickImage && (
        <>
          <Btn onClick={() => fileRef.current?.click()} label="Insert image (or paste / drag one in)">
            <ImagePlus className={TB_ICON} />
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPickImage(file);
              e.target.value = "";
            }}
          />
        </>
      )}
      <Btn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} label="Inline code">
        <CodeIcon className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock") && editor.getAttributes("codeBlock").language !== "email"}
        label="Code block"
      >
        <SquareCode className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => {
          if (editor.isActive("codeBlock", { language: "email" })) {
            editor.chain().focus().toggleCodeBlock().run();
            return;
          }
          editor
            .chain()
            .focus()
            .insertContent({
              type: "codeBlock",
              attrs: { language: "email" },
              content: [{ type: "text", text: EMAIL_STARTER }],
            })
            .run();
        }}
        active={editor.isActive("codeBlock", { language: "email" })}
        label="Email template — a copy-paste email block with Subject/To fields"
      >
        <Mail className={TB_ICON} />
      </Btn>
      {editor.isActive("image") && (
        <>
          <Divider />
          <Btn
            onClick={() => {
              const prev = (editor.getAttributes("image").alt as string) ?? "";
              const alt = window.prompt(
                "Describe this image (alt text — read aloud by screen readers, shown if the image can't load):",
                prev
              );
              if (alt === null) return;
              editor.chain().focus().updateAttributes("image", { alt: alt.trim() }).run();
            }}
            active={Boolean(editor.getAttributes("image").alt)}
            label="Alt text — describe the image for accessibility"
          >
            Alt
          </Btn>
          <span className="px-1 text-xs font-medium text-slate-400">Image size</span>
          {IMAGE_SIZES.map((s) => (
            <Btn
              key={s.label}
              onClick={() =>
                editor.chain().focus().updateAttributes("image", { title: s.title }).run()
              }
              active={(editor.getAttributes("image").title ?? null) === s.title}
              label={s.title ? `Display at ${s.title.slice(2)}` : "Full width"}
            >
              {s.label}
            </Btn>
          ))}
        </>
      )}
    </div>
  );
}

function Btn({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium transition ${
        active ? "bg-compass-100 text-compass-700" : "text-slate-500 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />;
}
