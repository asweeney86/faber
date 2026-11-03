import { createContext, useContext, useState } from "react";
import type { Doc, PbClient } from "@faber/shared";
import { SourceIcon } from "./icons";

type IconDoc = Pick<Doc, "id" | "source" | "canonical_url">;

/**
 * The API client whose daemon serves the icons (/api/docs/:id/favicon). The app provides
 * its client; the launcher provides its host's, so the app, the Mac launcher and the
 * extension all get icons the same way. No client = the built-in icons.
 */
export const IconClientContext = createContext<Pick<PbClient, "faviconUrl"> | null>(null);

/** Sites (and Google doc kinds) known to have no icon, so other docs from them don't ask again this session. */
const noIcon = new Set<string>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * A document's icon: the site's own favicon (Google's for Docs, Slides and Sheets), or the
 * built-in glyph while it loads, when there is none, or when icons are off.
 */
export function DocIcon({ doc, size = 16 }: { doc: IconDoc; size?: number }) {
  const client = useContext(IconClientContext);
  const host = doc.source === "url" ? hostOf(doc.canonical_url) : doc.source;
  const src = client && host && !noIcon.has(host) ? client.faviconUrl(doc.id) : null;
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  if (!src || state === "none") return <SourceIcon source={doc.source} size={size} />;
  return (
    <>
      {state === "loading" && <SourceIcon source={doc.source} size={size} />}
      <img
        className="favicon"
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden
        // Hidden (not display:none, which would stop it loading) until it arrives; a 204 "no icon" is an error.
        style={state === "loading" ? { position: "absolute", opacity: 0, pointerEvents: "none" } : undefined}
        onLoad={() => setState("ok")}
        onError={() => {
          noIcon.add(host);
          setState("none");
        }}
      />
    </>
  );
}
