export type DocType = "sop" | "technical" | "policy" | "knowledge";
export type DocStatus = "draft" | "published";

export const DOC_TYPES: { value: DocType; label: string; blurb: string }[] = [
  { value: "sop", label: "SOP", blurb: "Step-by-step standard operating procedures" },
  { value: "technical", label: "Technical", blurb: "Architecture, runbooks, and API docs" },
  { value: "policy", label: "Policy", blurb: "Company rules, compliance, and guidelines" },
  { value: "knowledge", label: "Knowledge", blurb: "How-tos, FAQs, and tribal knowledge" },
];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  sop: "SOP",
  technical: "Technical",
  policy: "Policy",
  knowledge: "Knowledge",
};

export interface Space {
  id: number;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  created_at: string;
}

export interface Document {
  id: number;
  space_id: number;
  title: string;
  slug: string;
  type: DocType;
  status: DocStatus;
  content: string;
  summary: string;
  tags: string[];
  author: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentWithSpace extends Document {
  space_name: string;
  space_slug: string;
  space_icon: string;
  space_color: string;
}

export interface DocVersion {
  id: number;
  document_id: number;
  title: string;
  content: string;
  author: string;
  note: string;
  created_at: string;
}

export interface SearchHit {
  id: number;
  title: string;
  slug: string;
  type: DocType;
  status: DocStatus;
  space_name: string;
  space_slug: string;
  space_icon: string;
  space_color: string;
  tags: string[];
  snippet: string;
  updated_at: string;
}
