#!/usr/bin/env bun
/**
 * Build the native macOS launcher: packages/macos/build/Faber Launcher.app
 *
 *   bun run build:macos        (needs the Xcode command line tools: swiftc, iconutil, codesign)
 *
 * The app is ad-hoc signed, so it runs on this Mac. Open it once; it lives in the
 * menu bar and listens for ⌥Space (see Sources/main.swift for settings).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "..", "..");
const out = process.env.FABER_MACOS_OUT ?? join(here, "build");
const app = join(out, "Faber Launcher.app");
const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version;

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "inherit" });

export function infoPlist(v: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.faber.launcher</string>
  <key>CFBundleName</key><string>Faber Launcher</string>
  <key>CFBundleDisplayName</key><string>Faber Launcher</string>
  <key>CFBundleExecutable</key><string>FaberLauncher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${v}</string>
  <key>CFBundleVersion</key><string>${v}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu bar only: no Dock icon. -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The daemon is plain http on 127.0.0.1; allow local networking only. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;
}

/** Every tool the build needs, or a message saying how to get them. */
function missingTools(): string[] {
  return ["swiftc", "iconutil", "codesign"].filter((tool) => {
    try {
      execFileSync("xcrun", ["--find", tool], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error("The native launcher is macOS only.");
    process.exit(1);
  }
  const missing = missingTools();
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}. Install the Xcode command line tools: xcode-select --install`);
    process.exit(1);
  }
  const png = (n: number) => join(root, "brand", "png", `faber-icon-${n}.png`);
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const absent = sizes.filter((n) => !existsSync(png(n)));
  if (absent.length) {
    console.error(`Missing brand icons (${absent.map((n) => `faber-icon-${n}.png`).join(", ")}). Run: bun run brand`);
    process.exit(1);
  }

  // Build next to the old app and swap at the end, so a failed build leaves the old one working.
  mkdirSync(out, { recursive: true });
  const staging = join(out, ".staging");
  rmSync(staging, { recursive: true, force: true });
  const next = join(staging, "Faber Launcher.app");
  const contents = join(next, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });

  run("swiftc", [
    "-O",
    "-swift-version",
    "5",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
    join(here, "Sources", "main.swift"),
    "-o",
    join(contents, "MacOS", "FaberLauncher"),
    "-framework",
    "Cocoa",
    "-framework",
    "WebKit",
    "-framework",
    "Carbon",
    "-framework",
    "ServiceManagement",
  ]);
  writeFileSync(join(contents, "Info.plist"), infoPlist(version));

  // App icon from the brand PNGs (bun run brand).
  const iconset = join(staging, "AppIcon.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const [name, size] of [
    ["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256],
    ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024],
  ] as const) {
    copyFileSync(png(size), join(iconset, `icon_${name}.png`));
  }
  run("iconutil", ["-c", "icns", iconset, "-o", join(contents, "Resources", "AppIcon.icns")]);
  run("codesign", ["--force", "--sign", "-", next]);

  rmSync(app, { recursive: true, force: true });
  renameSync(next, app);
  rmSync(staging, { recursive: true, force: true });
  console.log(`Built ${app}`);
}
