import type { DocSource } from "@faber/shared";

type P = { size?: number; className?: string };

const svg = (size: number, className: string | undefined, children: React.ReactNode, strokeWidth = 1.75) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconHome = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /><path d="M10 20v-6h4v6" /></>);
export const IconSearch = ({ size = 16, className }: P) =>
  svg(size, className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconFolder = ({ size = 16, className }: P) =>
  svg(size, className, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const IconUsers = ({ size = 16, className }: P) =>
  svg(size, className, <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M18 14a6.5 6.5 0 0 1 3.5 6" /></>);
export const IconSparkle = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m12 8 1.6 2.4L16 12l-2.4 1.6L12 16l-1.6-2.4L8 12l2.4-1.6z" /></>);
export const IconSettings = ({ size = 16, className }: P) =>
  svg(size, className, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, 1.5);
export const IconPin = ({ size = 16, className, filled }: P & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M6 3h12v18l-6-4.2L6 21z" />
  </svg>
);
export const IconExternal = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
export const IconX = ({ size = 14, className }: P) => svg(size, className, <path d="M6 6l12 12M18 6 6 18" />, 2);
export const IconPlus = ({ size = 14, className }: P) => svg(size, className, <path d="M12 5v14M5 12h14" />, 2);
export const IconCalendar = ({ size = 14, className }: P) =>
  svg(size, className, <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>);
export const IconRefresh = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
export const IconTrash = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IconDownload = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
export const IconUpload = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M12 15V4M7 9l5-5 5 5" /><path d="M5 20h14" /></>);
export const IconChevron = ({ size = 14, className }: P) => svg(size, className, <path d="m9 6 6 6-6 6" />, 2);
export const IconAlert = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>);
export const IconEye = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const IconEyeOff = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IconArrowRight = ({ size = 14, className }: P) => svg(size, className, <path d="M5 12h14M13 6l6 6-6 6" />);

/** Colored per-source glyph: blue doc, amber slides, green sheet, gray link. */
export function SourceIcon({ source, size = 16 }: { source: DocSource; size?: number }) {
  const cls = `source-icon source-${source}`;
  if (source === "gslides")
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" className={cls} aria-label="Google Slides" role="img">
        <rect x="3" y="2" width="14" height="16" rx="2.5" fill="currentColor" />
        <rect x="6" y="7" width="8" height="6" rx="1" fill="white" opacity="0.95" />
      </svg>
    );
  if (source === "gsheets")
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" className={cls} aria-label="Google Sheets" role="img">
        <rect x="3" y="2" width="14" height="16" rx="2.5" fill="currentColor" />
        <path d="M6 7h8v7H6zM6 10.5h8M10 7v7" stroke="white" strokeWidth="1.3" fill="none" opacity="0.95" />
      </svg>
    );
  if (source === "url")
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" className={cls} aria-label="Web page" role="img">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M2.5 10h15M10 2.5c2.2 2.3 2.2 12.7 0 15M10 2.5c-2.2 2.3-2.2 12.7 0 15" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={cls} aria-label="Google Docs" role="img">
      <path d="M5 2h7l5 5v9.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 16.5v-13A1.5 1.5 0 0 1 5.5 2z" fill="currentColor" />
      <path d="M7 10h6M7 12.5h6M7 15h4" stroke="white" strokeWidth="1.3" strokeLinecap="round" opacity="0.95" />
    </svg>
  );
}

/** Pushpin: "keep in this collection". The bookmark (IconPin) is reserved for the global pin. */
export const IconPushpin = ({ size = 14, className }: P) =>
  svg(size, className, <><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z" /><path d="M12 14v6" /></>);
export const IconChevronDown = ({ size = 12, className }: P) => svg(size, className, <path d="m6 9 6 6 6-6" />, 2);
export const IconFilter = ({ size = 14, className }: P) => svg(size, className, <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />);
export const IconCopy = ({ size = 13, className }: P) =>
  svg(size, className, <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>);
export const IconCheck = ({ size = 13, className }: P) => svg(size, className, <path d="m5 12.5 4.5 4.5L19 7.5" />, 2.2);
export const IconPanel = ({ size = 15, className }: P) =>
  svg(size, className, <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M14 4.5v15" /></>);

// ---------- Added for the v2 design (same 24px grid, 1.75 stroke) ----------

export const IconLayers = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>);
export const IconClock = ({ size = 16, className }: P) => svg(size, className, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconBookmark = ({ size = 16, className }: P) => svg(size, className, <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />);
export const IconHash = ({ size = 16, className }: P) => svg(size, className, <path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18" />);
export const IconGrid = ({ size = 16, className }: P) =>
  svg(size, className, <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>);
export const IconOpenApp = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M13 4h7v7" /><path d="M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>);
export const IconActivity = ({ size = 16, className }: P) => svg(size, className, <path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IconBarChart = ({ size = 16, className }: P) => svg(size, className, <path d="M5 20v-6M10 20V9M15 20v-9M20 20V4" />, 2);
export const IconTarget = ({ size = 16, className }: P) =>
  svg(size, className, <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" /></>);
export const IconPalette = ({ size = 16, className }: P) =>
  svg(
    size,
    className,
    <><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.7 0-1 .8-1.6 1.8-1.6h2.1a3.9 3.9 0 0 0 3.9-3.9c0-4-3.8-7.1-8.5-7.1z" /><circle cx="7.6" cy="11" r="1" /><circle cx="10.5" cy="7.3" r="1" /><circle cx="15" cy="7.8" r="1" /></>,
  );
export const IconKeyboard = ({ size = 16, className }: P) =>
  svg(size, className, <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9" /></>);
export const IconCpu = ({ size = 16, className }: P) =>
  svg(size, className, <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="0.8" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>);
export const IconShield = ({ size = 16, className }: P) => svg(size, className, <><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></>);
export const IconSitemap = ({ size = 16, className }: P) =>
  svg(size, className, <><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-2h12v2" /></>);
export const IconMonitor = ({ size = 16, className }: P) => svg(size, className, <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
export const IconCheckCircle = ({ size = 16, className }: P) => svg(size, className, <><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.3 2.4 2.4 4.8-5" /></>);
export const IconFile = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6" /></>);
export const IconEnter = ({ size = 14, className }: P) => svg(size, className, <><path d="M19 5v7a3 3 0 0 1-3 3H6" /><path d="m10 11-4 4 4 4" /></>);
export const IconArrowUp = ({ size = 12, className }: P) => svg(size, className, <path d="M12 19V5M6 11l6-6 6 6" />, 2);
export const IconArrowDown = ({ size = 12, className }: P) => svg(size, className, <path d="M12 5v14M6 13l6 6 6-6" />, 2);
export const IconChevronLeft = ({ size = 14, className }: P) => svg(size, className, <path d="m15 6-6 6 6 6" />, 2);
export const IconPlay = ({ size = 16, className }: P) => svg(size, className, <path d="M7 4.5v15l12-7.5z" />);
export const IconPlug = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>);
export const IconDatabase = ({ size = 16, className }: P) =>
  svg(size, className, <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></>);
export const IconInbox = ({ size = 16, className }: P) =>
  svg(size, className, <><path d="M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z" /><path d="M3.5 13.5H9l1.5 2.5h3l1.5-2.5h5.5" /></>);
