// Markdown for Claude's replies - rendered and sanitised the same way the Tuning Log does it.
import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? "")));
}
