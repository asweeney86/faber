import type { DocTag, DocType } from "@faber/shared";
import { BRAND, ICON_RIBBON_PATH, ICON_VIEWBOX, TILE_RADIUS } from "@faber/shared";
import { docTypeLabel } from "../lib/format";

/** Icons drawn on the same 24px grid and stroke as the web app's icon set. */
const PATHS = {
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.5-3.5",
  x: "M6 6l12 12M18 6 6 18",
  external: "M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  plus: "M12 5v14M5 12h14",
  bookmark: "M6 3h12v18l-6-4.2L6 21z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  power: "M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0",
  alert: "M12 3 2 20h20zM12 10v4M12 17h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "x" || name === "plus" ? 2 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The app icon (violet tile, white ribbon), from the shared brand geometry: the same image as the toolbar icon. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox={ICON_VIEWBOX} width={size} height={size} aria-hidden="true">
      <rect className="faber-tile" width="64" height="64" rx={TILE_RADIUS} fill={BRAND.tile} />
      <path className="faber-ribbon" d={ICON_RIBBON_PATH} fill={BRAND.white} />
    </svg>
  );
}

export function TypeBadge({ type }: { type: DocType }) {
  return <span className={`badge type-${type}`}>{docTypeLabel(type)}</span>;
}

/** "#tag" tags: dashed outline for auto tags, soft accent for ones you added (same as the web app). */
export function TagList({ tags, max, onRemove }: { tags: DocTag[]; max?: number; onRemove?: (tag: string) => void }) {
  const shown = max === undefined ? tags : tags.slice(0, max);
  const more = tags.length - shown.length;
  return (
    <>
      {shown.map((t) => (
        <span key={t.tag} className={`tag tag-${t.source}`} title={t.source === "auto" ? "Added automatically" : "Added by you"}>
          #{t.tag}
          {onRemove && (
            <button type="button" className="tag-remove" aria-label={`Remove tag ${t.tag}`} onClick={() => onRemove(t.tag)}>
              <Icon name="x" size={10} />
            </button>
          )}
        </span>
      ))}
      {more > 0 && (
        <span className="tag tag-more" title={tags.slice(shown.length).map((t) => `#${t.tag}`).join(" ")}>
          +{more}
        </span>
      )}
    </>
  );
}

/** Checkbox switch with the web app's markup, so it looks and behaves the same. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
    </label>
  );
}
