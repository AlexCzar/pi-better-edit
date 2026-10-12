import type { LineEnding } from "../edit-diff.js";

export interface NormText {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  hadUtf8DecodeErrors: boolean;
}

export interface NormFile extends NormText {
  fileHashes: string[];
}
