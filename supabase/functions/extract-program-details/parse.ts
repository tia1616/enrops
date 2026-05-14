// Document parsing — turns a file's bytes into plain text the LLM can read.
// Supports: .pdf, .docx, .txt, .md, .xlsx
//
// Library choices:
//   - unpdf: Deno-native PDF text extraction (no native deps, edge-friendly)
//   - mammoth: docx → text
//   - xlsx (SheetJS): xlsx → CSV-ish text

import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import mammoth from "npm:mammoth@1.8.0";
import * as XLSX from "npm:xlsx@0.18.5";

export type SupportedExt = "pdf" | "docx" | "txt" | "md" | "xlsx";

export function detectExt(filename: string): SupportedExt | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return null;
}

export async function parseDocument(bytes: Uint8Array, ext: SupportedExt): Promise<string> {
  switch (ext) {
    case "pdf": {
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join("\n\n") : text;
    }
    case "docx": {
      // mammoth wants a Buffer or { buffer } — give it the underlying ArrayBuffer.
      const result = await mammoth.extractRawText({
        buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      });
      return result.value;
    }
    case "txt":
    case "md": {
      return new TextDecoder("utf-8").decode(bytes);
    }
    case "xlsx": {
      const wb = XLSX.read(bytes, { type: "array" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        parts.push(`### Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}`);
      }
      return parts.join("\n\n");
    }
  }
}
