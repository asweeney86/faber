#!/usr/bin/env bun
/**
 * Toolbar states for the current tab (see packages/extension/src/lib/tabstate.ts).
 * Flat tile at these sizes; every state keeps the same tile + ribbon silhouette.
 */
export declare const ACTION_SVGS: {
    readonly saved: string;
    readonly pinned: string;
    /** Not saved: outlined tile and outlined ribbon in grey. */
    readonly unsaved: string;
    /** Unknown (offline, unpaired, no access): neutral grey tile, solid ribbon. */
    readonly unknown: string;
};
/** Every SVG written to brand/, by path relative to it. */
export declare function svgFiles(): Record<string, string>;
/** A .ico holding PNG images (supported by every browser since Windows Vista-era formats). */
export declare function icoFromPngs(images: {
    size: number;
    png: Uint8Array;
}[]): Uint8Array;
