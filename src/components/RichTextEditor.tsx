"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import { Node, Extension, mergeAttributes, getHTMLFromFragment } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { Markdown } from "tiptap-markdown";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Underline as UnderlineIcon,
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
  AlignLeft,
  AlignCenter,
  AlignRight,
  IndentIncrease,
  IndentDecrease,
  RemoveFormatting,
  Paintbrush,
  Minus,
  MousePointerSquareDashed,
  UnfoldVertical,
} from "lucide-react";

// Starter content inserted by the "Email template" toolbar button. Rendered
// on document pages as a letter-style card with copy buttons (```email).
const EMAIL_STARTER = `Subject:

Hi ,



Thanks,
`;

const TB_ICON = "h-4 w-4";

// Indent steps are stored as a small integer and rendered as margin-left, so
// the value survives the HTML round-trip through Markdown.
const INDENT_STEP_PX = 32;
const INDENT_MAX = 4;

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

const SPACER_SIZES: { label: string; size: number }[] = [
  { label: "S", size: 16 },
  { label: "M", size: 32 },
  { label: "L", size: 48 },
];

// --- Markdown round-trip for styled blocks -----------------------------------
// Markdown can't express alignment or indent, so paragraphs/headings carrying
// either serialize as a single line of HTML (which markdown-it hands back to
// the ProseMirror parser on load). Unstyled blocks keep plain Markdown.

function blockIsStyled(node: any): boolean {
  const align = node.attrs?.textAlign;
  return (align && align !== "left") || (node.attrs?.indent ?? 0) > 0;
}

function writeBlockAsHtml(state: any, node: any): void {
  const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
  state.write(html);
  state.closeBlock(node);
}

const MdParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          if (blockIsStyled(node)) return writeBlockAsHtml(state, node);
          state.renderInline(node);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

const MdHeading = Heading.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          if (blockIsStyled(node)) return writeBlockAsHtml(state, node);
          state.write(state.repeat("#", node.attrs.level) + " ");
          state.renderInline(node, false);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// Paragraph/heading indent, persisted as margin-left in the HTML form.
const Indentable = Extension.create({
  name: "indentable",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => {
              const m = /margin-left:\s*(\d{1,3})px/.exec(el.getAttribute("style") || "");
              return m ? Math.max(0, Math.min(INDENT_MAX, Math.round(Number(m[1]) / INDENT_STEP_PX))) : 0;
            },
            renderHTML: (attrs: any) =>
              attrs.indent > 0 ? { style: `margin-left: ${attrs.indent * INDENT_STEP_PX}px` } : {},
          },
        },
      },
    ];
  },
});

// A call-to-action button for newsletters: stored as a styled link the email
// renderer (and doc view CSS) turn into a real button.
const EmailButton = Node.create({
  name: "emailButton",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      label: { default: "Open" },
      href: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "a.email-btn",
        getAttrs: (el) => ({
          label: (el as HTMLElement).textContent?.trim() || "Open",
          href: (el as HTMLElement).getAttribute("href") || "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["a", { class: "email-btn", href: node.attrs.href }, node.attrs.label];
  },
});

// Vertical breathing room between newsletter sections.
const SpacerBlock = Node.create({
  name: "spacerBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      size: {
        default: 32,
        parseHTML: (el: HTMLElement) => {
          const m = /height:\s*(\d{1,3})px/.exec(el.getAttribute("style") || "");
          return m ? Math.max(8, Math.min(120, Number(m[1]))) : 32;
        },
        renderHTML: (attrs: any) => ({ style: `height:${attrs.size}px` }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div.nl-spacer" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ class: "nl-spacer" }, HTMLAttributes)];
  },
});

// A WYSIWYG editor for people who don't want to write Markdown. It reads and
// writes Markdown under the hood (via tiptap-markdown), so the stored content,
// search, export, and preview all stay Markdown — the same format the raw
// editor uses. Formatting Markdown can't express (underline, alignment,
// indent, buttons, spacers) is stored as small sanitized HTML islands.
// Parent owns the Markdown string; this component just presents it.
export function RichTextEditor({
  value,
  onChange,
  onUploadImage,
  emailBlocks = false,
}: {
  value: string;
  onChange: (markdown: string) => void;
  /** Upload an image file, resolving to its serving URL (null on failure). */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** Show the newsletter block tools (button, spacer). */
  emailBlocks?: boolean;
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
      StarterKit.configure({ heading: false, paragraph: false }),
      MdParagraph,
      MdHeading.configure({ levels: [1, 2, 3] }),
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Indentable,
      EmailButton,
      SpacerBlock,
      Link.configure({ openOnClick: false, autolink: true }),
      SizableImage,
      Markdown.configure({ html: true, linkify: true, breaks: true }),
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
        emailBlocks={emailBlocks}
        onPickImage={onUploadImage ? (file) => insertUploaded(editor, file) : undefined}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

// Formatting captured by the format painter: the marks (with attrs) plus the
// block's alignment.
interface PaintedFormat {
  marks: { type: string; attrs: Record<string, any> }[];
  align: string | null;
}

function Toolbar({
  editor,
  emailBlocks,
  onPickImage,
}: {
  editor: Editor;
  emailBlocks: boolean;
  onPickImage?: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [painted, setPainted] = useState<PaintedFormat | null>(null);

  // Format painter: after copying, the next text selection receives the
  // copied formatting and the painter switches itself off. Debounced so a
  // drag- or shift-selection applies once it settles, not on the first
  // selectionUpdate of the gesture.
  useEffect(() => {
    if (!painted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const sel = editor.state.selection;
        if (sel.empty) return;
        const chain = editor.chain().focus().unsetAllMarks();
        for (const m of painted.marks) chain.setMark(m.type, m.attrs);
        if (painted.align) chain.setTextAlign(painted.align);
        chain.run();
        setPainted(null);
      }, 300);
    };
    editor.on("selectionUpdate", apply);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("selectionUpdate", apply);
    };
  }, [editor, painted]);

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

  function copyFormat() {
    if (painted) {
      setPainted(null); // second click cancels
      editor.commands.focus();
      return;
    }
    // Marks to copy: pending input marks first, then the caret position, then
    // (for a range selection) the first character inside the range.
    const { state } = editor;
    const { empty, from } = state.selection;
    let copied = state.storedMarks ?? state.selection.$head.marks();
    if (copied.length === 0 && !empty) {
      copied = state.doc.resolve(Math.min(from + 1, state.doc.content.size)).marks();
    }
    const marks = copied.map((m) => ({ type: m.type.name, attrs: { ...m.attrs } }));
    const align =
      (editor.getAttributes("paragraph").textAlign as string | undefined) ||
      (editor.getAttributes("heading").textAlign as string | undefined) ||
      null;
    setPainted({ marks, align: align && align !== "left" ? align : null });
    // Hand focus straight back so the user can select the target text.
    editor.commands.focus();
  }

  function changeIndent(dir: 1 | -1) {
    if (editor.isActive("listItem")) {
      if (dir === 1) editor.chain().focus().sinkListItem("listItem").run();
      else editor.chain().focus().liftListItem("listItem").run();
      return;
    }
    const type = editor.isActive("heading") ? "heading" : "paragraph";
    const cur = Number(editor.getAttributes(type).indent) || 0;
    const next = Math.max(0, Math.min(INDENT_MAX, cur + dir));
    editor.chain().focus().updateAttributes(type, { indent: next }).run();
  }

  function clearFormatting() {
    editor
      .chain()
      .focus()
      .clearNodes()
      .unsetAllMarks()
      .unsetTextAlign()
      .updateAttributes("paragraph", { indent: 0 })
      .run();
  }

  function insertButton() {
    const label = window.prompt("Button label", "Read more");
    if (label === null) return;
    const href = window.prompt("Button link URL", "https://");
    if (href === null) return;
    editor
      .chain()
      .focus()
      .insertContent({ type: "emailButton", attrs: { label: label.trim() || "Open", href: href.trim() } })
      .run();
  }

  const align = (editor.getAttributes("paragraph").textAlign ||
    editor.getAttributes("heading").textAlign ||
    "left") as string;

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-100 px-2 py-1.5">
      <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} label="Bold">
        <BoldIcon className={TB_ICON} />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} label="Italic">
        <ItalicIcon className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")}
        label="Underline"
      >
        <UnderlineIcon className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        label="Strikethrough"
      >
        <Strikethrough className={TB_ICON} />
      </Btn>
      <Btn onClick={copyFormat} active={!!painted} label={painted ? "Select text to apply the copied formatting (click again to cancel)" : "Format painter — copy this formatting, then select text to apply it"}>
        <Paintbrush className={TB_ICON} />
      </Btn>
      <Btn onClick={clearFormatting} label="Clear formatting">
        <RemoveFormatting className={TB_ICON} />
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
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        active={align === "left"}
        label="Align left"
      >
        <AlignLeft className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        active={align === "center"}
        label="Align center"
      >
        <AlignCenter className={TB_ICON} />
      </Btn>
      <Btn
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
        active={align === "right"}
        label="Align right"
      >
        <AlignRight className={TB_ICON} />
      </Btn>
      <Btn onClick={() => changeIndent(1)} label="Increase indent (nests list items)">
        <IndentIncrease className={TB_ICON} />
      </Btn>
      <Btn onClick={() => changeIndent(-1)} label="Decrease indent">
        <IndentDecrease className={TB_ICON} />
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
      <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} label="Divider line">
        <Minus className={TB_ICON} />
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
      {emailBlocks && (
        <>
          <Btn onClick={insertButton} active={editor.isActive("emailButton")} label="Button — a call-to-action link styled as a button">
            <MousePointerSquareDashed className={TB_ICON} />
          </Btn>
          <Btn
            onClick={() => editor.chain().focus().insertContent({ type: "spacerBlock" }).run()}
            active={editor.isActive("spacerBlock")}
            label="Spacer — vertical breathing room between sections"
          >
            <UnfoldVertical className={TB_ICON} />
          </Btn>
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
      {editor.isActive("emailButton") && (
        <>
          <Divider />
          <Btn
            onClick={() => {
              const attrs = editor.getAttributes("emailButton");
              const label = window.prompt("Button label", String(attrs.label ?? ""));
              if (label === null) return;
              const href = window.prompt("Button link URL", String(attrs.href ?? "https://"));
              if (href === null) return;
              editor
                .chain()
                .focus()
                .updateAttributes("emailButton", { label: label.trim() || "Open", href: href.trim() })
                .run();
            }}
            label="Edit the button's label and link"
          >
            Edit button
          </Btn>
        </>
      )}
      {editor.isActive("spacerBlock") && (
        <>
          <Divider />
          <span className="px-1 text-xs font-medium text-slate-400">Spacer size</span>
          {SPACER_SIZES.map((s) => (
            <Btn
              key={s.label}
              onClick={() => editor.chain().focus().updateAttributes("spacerBlock", { size: s.size }).run()}
              active={Number(editor.getAttributes("spacerBlock").size) === s.size}
              label={`${s.size}px tall`}
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
      className={`group relative flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium transition ${
        active ? "bg-compass-100 text-compass-700" : "text-slate-500 hover:bg-slate-100"
      }`}
    >
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden max-w-56 -translate-x-1/2 whitespace-normal rounded-md bg-slate-900 px-2 py-1 text-center text-[11px] font-medium leading-snug text-slate-50 shadow-md group-hover:block group-focus-visible:block">
        {label}
      </span>
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />;
}
