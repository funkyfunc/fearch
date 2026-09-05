/** `binary`: a response that is not a document at all (an image, an archive, an executable). */
export type ContentKind = "html" | "markdown" | "text" | "pdf" | "json" | "binary";

export interface Fetched {
  url: string;
  finalUrl: string;
  kind: ContentKind;
  body: string | Uint8Array;
  source: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
}

export function fetchedText(f: Fetched): string {
  return typeof f.body === "string" ? f.body : new TextDecoder("utf-8", { fatal: false }).decode(f.body);
}

/** Minimal HTTP surface injected into fast paths and providers so they are testable. */
export interface HttpInit {
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
}

export interface HttpLike {
  (
    url: string,
    init?: HttpInit,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}
