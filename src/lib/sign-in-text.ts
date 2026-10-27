// The sign-in page's admin text and layout choices (1.16.0): limits,
// normalisation and the small maps shared by the page, the admin settings
// and the save route. Isomorphic: no server imports.

export const SIGN_IN_LIMITS = {
  headline: 60,
  tagline: 140,
  caption: 80,
  help: 160,
  help_url: 500,
  example: 64,
} as const;

export type SignInTextKey = keyof typeof SIGN_IN_LIMITS;

export const SIGN_IN_FIELD_LABEL: Record<SignInTextKey, string> = {
  headline: "Headline",
  tagline: "Tagline",
  caption: "Caption",
  help: "Help text",
  help_url: "Help link",
  example: "Example email",
};

/** Where the picture's subject is: the part kept in view when a screen crops it. */
export const FOCUS_POINTS = ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"] as const;
export type Focus = (typeof FOCUS_POINTS)[number];

export const FOCUS_POSITION: Record<Focus, string> = {
  tl: "0% 0%",
  t: "50% 0%",
  tr: "100% 0%",
  l: "0% 50%",
  c: "50% 50%",
  r: "100% 50%",
  bl: "0% 100%",
  b: "50% 100%",
  br: "100% 100%",
};

export const FOCUS_LABEL: Record<Focus, string> = {
  tl: "Top left",
  t: "Top",
  tr: "Top right",
  l: "Left",
  c: "Center",
  r: "Right",
  bl: "Bottom left",
  b: "Bottom",
  br: "Bottom right",
};

export function asFocus(v: unknown): Focus {
  return (FOCUS_POINTS as readonly string[]).includes(String(v)) ? (v as Focus) : "c";
}

/** Which side of the page the artwork takes from 64rem: "start" is the left. */
export type ArtSide = "start" | "end";
export function asSide(v: unknown): ArtSide {
  return v === "end" ? "end" : "start";
}

/** The `sizes` for the artwork's srcset: the cover's share of the viewport. */
export const ART_SIZES = "(min-width: 120rem) 80vw, (min-width: 64rem) 66vw, 100vw";

/** The display tier for the cover's big line, by length: short names set largest. */
export function lenTier(s: string): "s" | "m" | "l" {
  const n = [...s].length;
  return n <= 18 ? "s" : n <= 36 ? "m" : "l";
}

/**
 * Admin text as stored: Unicode NFC, control characters and line breaks
 * dropped, runs of whitespace collapsed to one space, trimmed. Over-long
 * text is refused by the caller, never cut.
 */
export function normalizeSignInText(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence for a help link that is not https: or mailto:, or null when it is fine (or empty). */
export function helpUrlProblem(url: string): string | null {
  if (!url) return null;
  // The text as typed must start so too: "https:host" parses with a host on
  // its own, but in an href on an https page it is a same-origin path.
  if (/^(https:\/\/|mailto:)/i.test(url)) {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && u.hostname) return null;
      if (u.protocol === "mailto:" && u.pathname.includes("@")) return null;
    } catch {
      // fall through
    }
  }
  return "Use an address that starts with https:// or mailto:.";
}

/** The sentence for a value over its limit, or null. */
export function lengthProblem(key: SignInTextKey, value: string): string | null {
  const max = SIGN_IN_LIMITS[key];
  return [...value].length > max ? `${SIGN_IN_FIELD_LABEL[key]} is limited to ${max} characters.` : null;
}

/** Everything the sign-in page shows that an admin chose (lib/sign-in-art getSignInLook reads it). */
export interface SignInText {
  headline: string;
  tagline: string;
  caption: string;
  help: string;
  help_url: string;
  example: string;
  focus: Focus;
  side: ArtSide;
  /** Show the name and headline over a photo (the default art always shows them). */
  show_text: boolean;
}

export const SIGN_IN_TEXT_DEFAULTS: SignInText = {
  headline: "",
  tagline: "",
  caption: "",
  help: "",
  help_url: "",
  example: "",
  focus: "c",
  side: "start",
  show_text: true,
};

/**
 * A body from the admin save, normalised, with a sentence per refused field.
 * Values that are refused keep the normalised input so the form can show it.
 */
export function parseSignInText(body: Record<string, unknown>): { value: SignInText; fields: Partial<Record<keyof SignInText, string>> } {
  const fields: Partial<Record<keyof SignInText, string>> = {};
  const text = (k: SignInTextKey) => {
    const v = normalizeSignInText(body[k]);
    const p = lengthProblem(k, v);
    if (p) fields[k] = p;
    return v;
  };
  const value: SignInText = {
    headline: text("headline"),
    tagline: text("tagline"),
    caption: text("caption"),
    help: text("help"),
    help_url: text("help_url"),
    example: text("example"),
    focus: asFocus(body.focus),
    side: asSide(body.side),
    show_text: body.show_text !== false && body.show_text !== "0",
  };
  if (!fields.help_url) {
    const p = helpUrlProblem(value.help_url);
    if (p) fields.help_url = p;
  }
  return { value, fields };
}
