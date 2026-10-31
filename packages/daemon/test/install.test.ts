import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getSettings, listExtensions, openDatabase, setConfigValue } from "@faber/core";
import { appVersion, extensionVersion, syncExtension, syncLauncher, treeHash } from "../src/install/assets";
import { brewPrefixOf, type Layout } from "../src/install/layout";
import { recommendedEnrichModel, SMALL_ENRICH_MODEL, DEFAULT_ENRICH_MODEL } from "../src/install/ollama";
import { launchdPlist, serviceKind, systemdUnit, UPGRADE_EXIT_CODE } from "../src/install/service";
import { chromeExtensionId, runSetup, type Host, type Io } from "../src/install/setup";
import { binaryIdentity, watchForUpgrade } from "../src/install/upgrade-watch";

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `faber-${name}-`));

function fakeExtension(dir: string, version: string, extra = "") {
  mkdirSync(join(dir, "icons"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Faber", version }));
  writeFileSync(join(dir, "background.js"), `// v${version}${extra}`);
  writeFileSync(join(dir, "icons", "icon-16.png"), "png");
  return dir;
}

function fakeApp(dir: string, version: string, bundleId = "dev.faber.launcher") {
  mkdirSync(join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(dir, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  writeFileSync(join(dir, "Contents", "MacOS", "FaberLauncher"), `bin ${version}`);
  return dir;
}

describe("install layout", () => {
  test("recognises a Homebrew keg and starts services from the stable opt path", () => {
    expect(brewPrefixOf("/opt/homebrew/Cellar/faber/0.1.0/bin/faber")).toBe("/opt/homebrew");
    expect(brewPrefixOf("/home/linuxbrew/.linuxbrew/Cellar/faber/1.2.3_1/bin/faber")).toBe("/home/linuxbrew/.linuxbrew");
    expect(brewPrefixOf("/usr/local/bin/faber")).toBeNull();
    expect(brewPrefixOf("/opt/homebrew/Cellar/other/0.1.0/bin/faber")).toBeNull();
  });
});

describe("Chrome extension id", () => {
  test("matches what Chrome assigns an unpacked folder (checked against Chromium)", () => {
    // Chromium loaded /tmp/faber-extid/my ext (realpath /private/tmp/…) as kggljjgapmpmnciadnmpbgggnakpcobk.
    expect(chromeExtensionId("/private/tmp/faber-extid/my ext")).toBe("kggljjgapmpmnciadnmpbgggnakpcobk");
    expect(chromeExtensionId("/a")).toMatch(/^[a-p]{32}$/);
  });
});

describe("syncing the installed extension and launcher", () => {
  test("installs, leaves an identical copy alone, and replaces a changed one", () => {
    const root = tmp("sync");
    const dest = join(root, "home", "extension");
    const v1 = fakeExtension(join(root, "v1"), "0.1.0");
    expect(syncExtension(v1, dest)).toBe("absent"); // the daemon never creates it; setup does
    expect(syncExtension(v1, dest, true)).toBe("installed");
    expect(extensionVersion(dest)).toBe("0.1.0");
    expect(syncExtension(v1, dest)).toBe("current");
    const v2 = fakeExtension(join(root, "v2"), "0.2.0");
    expect(syncExtension(v2, dest)).toBe("updated");
    expect(extensionVersion(dest)).toBe("0.2.0");
    expect(readFileSync(join(dest, "background.js"), "utf8")).toBe("// v0.2.0");
    // Nothing left behind next to it.
    expect(readdirSync(join(root, "home"))).toEqual(["extension"]);
    expect(syncExtension(null, dest)).toBe("unavailable");
  });

  test("the same version with different files still updates (hash, not version)", () => {
    const root = tmp("hash");
    const dest = join(root, "ext");
    syncExtension(fakeExtension(join(root, "a"), "0.1.0"), dest, true);
    expect(syncExtension(fakeExtension(join(root, "b"), "0.1.0", " fix"), dest)).toBe("updated");
    expect(treeHash(join(root, "b"))).not.toBe(treeHash(join(root, "a")));
  });

  test("a stale temp copy from a crash doesn't block the next update", () => {
    const root = tmp("crash");
    const dest = join(root, "ext");
    syncExtension(fakeExtension(join(root, "a"), "0.1.0"), dest, true);
    mkdirSync(`${dest}.new-123-456`);
    expect(syncExtension(fakeExtension(join(root, "b"), "0.2.0"), dest)).toBe("updated");
    expect(extensionVersion(dest)).toBe("0.2.0");
  });

  test("a crash between the two renames is repaired at the next start", () => {
    const root = tmp("swapcrash");
    const dest = join(root, "ext");
    syncExtension(fakeExtension(join(root, "a"), "0.1.0"), dest, true);
    renameSync(dest, `${dest}.old-1-2`); // the crash: old moved aside, new not yet in place
    mkdirSync(`${dest}.new-1-2`);
    expect(syncExtension(fakeExtension(join(root, "a"), "0.1.0"), dest)).toBe("current");
    expect(extensionVersion(dest)).toBe("0.1.0");
    expect(readdirSync(root).sort()).toEqual(["a", "ext"]);
  });

  test.skipIf(process.platform !== "darwin")("updates our launcher app but never someone else's", () => {
    const root = tmp("app");
    const dest = join(root, "Applications", "Faber Launcher.app");
    expect(syncLauncher(fakeApp(join(root, "v1.app"), "0.1.0"), dest, true)).toBe("installed");
    expect(syncLauncher(fakeApp(join(root, "v2.app"), "0.2.0"), dest)).toBe("updated");
    expect(appVersion(dest)).toBe("0.2.0");
    rmSync(dest, { recursive: true });
    fakeApp(dest, "9.9.9", "com.example.other");
    expect(syncLauncher(fakeApp(join(root, "v3.app"), "0.3.0"), dest)).toBe("unavailable");
    expect(appVersion(dest)).toBe("9.9.9");
  });
});

describe("background service definitions", () => {
  const env = { home: "/Users/x/.faber", env: { PATH: "/opt/homebrew/bin:/usr/bin" }, logFile: "/Users/x/.faber/logs/daemon.log" };

  test("launchd: stable command, restart on failure or upgrade only, logs", () => {
    const p = launchdPlist(["/opt/homebrew/opt/faber/bin/faber"], env);
    expect(p).toContain("<string>/opt/homebrew/opt/faber/bin/faber</string>\n    <string>serve</string>");
    expect(p).toContain("<key>FABER_SERVICE</key><string>1</string>");
    expect(p).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(p).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(p).toContain("<key>StandardErrorPath</key><string>/Users/x/.faber/logs/daemon.log</string>");
    expect(launchdPlist(["/a&b/<faber>"], env)).toContain("<string>/a&amp;b/&lt;faber&gt;</string>");
    expect(UPGRADE_EXIT_CODE).not.toBe(0);
  });

  test("systemd: quotes paths with spaces and restarts on failure", () => {
    const u = systemdUnit(["/home/x/my apps/faber"], env);
    expect(u).toContain(`ExecStart="/home/x/my apps/faber" serve`);
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain(`Environment=FABER_SERVICE=1`);
  });

  test("Homebrew installs use brew services; others the platform's own", () => {
    const layout = (brewPrefix: string | null): Layout => ({ compiled: true, exe: "/x", command: ["/x"], brewPrefix, extensionSrc: null, launcherSrc: null });
    expect(serviceKind(layout(null), "darwin")).toBe("launchd");
    expect(serviceKind(layout("/nonexistent-prefix"), "darwin")).toBe("launchd"); // no brew there
  });
});

describe("upgrade watch", () => {
  test("fires once when the binary is replaced", async () => {
    const dir = tmp("watch");
    const bin = join(dir, "faber");
    writeFileSync(bin, "v1");
    const events: string[] = [];
    const stop = watchForUpgrade(bin, (e) => events.push(e.kind), 10);
    await Bun.sleep(30);
    expect(events).toEqual([]);
    writeFileSync(`${bin}.new`, "v2 is longer");
    renameSync(`${bin}.new`, bin);
    await Bun.sleep(50);
    expect(events).toEqual(["replaced"]);
    stop();
  });

  test("follows symlinks like Homebrew's opt/ link", async () => {
    const dir = tmp("watch-link");
    mkdirSync(join(dir, "0.1.0"));
    mkdirSync(join(dir, "0.2.0"));
    writeFileSync(join(dir, "0.1.0", "faber"), "v1");
    writeFileSync(join(dir, "0.2.0", "faber"), "v2");
    const { symlinkSync, unlinkSync } = await import("node:fs");
    symlinkSync(join(dir, "0.1.0"), join(dir, "opt"));
    const bin = join(dir, "opt", "faber");
    const id = binaryIdentity(bin);
    expect(id).toContain(realpathSync(join(dir, "0.1.0", "faber")));
    const events: string[] = [];
    watchForUpgrade(bin, (e) => events.push(e.kind), 10);
    unlinkSync(join(dir, "opt"));
    symlinkSync(join(dir, "0.2.0"), join(dir, "opt"));
    await Bun.sleep(50);
    expect(events).toEqual(["replaced"]);
  });

  test("a brief gap mid-upgrade isn't mistaken for an uninstall", async () => {
    const dir = tmp("watch-gap");
    const bin = join(dir, "faber");
    writeFileSync(bin, "v1");
    const events: string[] = [];
    const stop = watchForUpgrade(bin, (e) => events.push(e.kind), 10, 5);
    rmSync(bin);
    await Bun.sleep(25);
    writeFileSync(bin, "v1"); // same content but a new file: still an upgrade
    await Bun.sleep(40);
    expect(events).toEqual(["replaced"]);
    stop();

    const bin2 = join(dir, "faber2");
    writeFileSync(bin2, "v1");
    const gone: string[] = [];
    watchForUpgrade(bin2, (e) => gone.push(e.kind), 5, 3);
    rmSync(bin2);
    await Bun.sleep(60);
    expect(gone).toEqual(["removed"]);
  });
});

describe("config edits", () => {
  const toml = `# top\n[embed]\nmodel = "qwen3-embedding"\n\n# [enrich]\n# model = "commented"\n[enrich]\nprovider = "ollama"\nmodel = "qwen3:8b" # default\n\n[privacy]\nallow_remote = false\n`;

  test("replaces the key in the right section and keeps everything else", () => {
    const out = setConfigValue(toml, "enrich", "model", "qwen3:4b");
    expect(out).toContain(`[enrich]\nprovider = "ollama"\nmodel = "qwen3:4b"\n`);
    expect(out).toContain(`[embed]\nmodel = "qwen3-embedding"`);
    expect(out).toContain(`# model = "commented"`);
    expect(out.split("\n").length).toBe(toml.split("\n").length);
  });

  test("finds a section header with a trailing comment", () => {
    const out = setConfigValue(`[enrich]  # mine\nmodel = "a"\n`, "enrich", "model", "b");
    expect(out).toBe(`[enrich]  # mine\nmodel = "b"\n`);
  });

  test("adds a missing key or section", () => {
    expect(setConfigValue(toml, "privacy", "note", "x")).toContain(`[privacy]\nnote = "x"\nallow_remote = false`);
    expect(setConfigValue("[a]\nb = 1", "daemon", "port", 7788)).toBe("[a]\nb = 1\n\n[daemon]\nport = 7788\n");
  });

  test("the default config can be edited and still loads", () => {
    const { DEFAULT_CONFIG_TOML } = require("@faber/core") as typeof import("@faber/core");
    const out = setConfigValue(DEFAULT_CONFIG_TOML, "enrich", "model", "qwen3:4b");
    const parsed = Bun.TOML.parse(out) as { enrich: { model: string }; embed: { model: string } };
    expect(parsed.enrich.model).toBe("qwen3:4b");
    expect(parsed.embed.model).toBe("qwen3-embedding");
  });
});

test("memory decides the default enrichment model", () => {
  expect(recommendedEnrichModel(8 * 1024 ** 3)).toBe(SMALL_ENRICH_MODEL);
  expect(recommendedEnrichModel(16 * 1024 ** 3)).toBe(DEFAULT_ENRICH_MODEL);
  expect(recommendedEnrichModel(64 * 1024 ** 3)).toBe(DEFAULT_ENRICH_MODEL);
});

describe("faber setup (no service, no AI)", () => {
  function fakeIo(answers: boolean[] = []): Io & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      interactive: false,
      line: (t = "") => lines.push(t),
      status: () => {},
      confirm: async (_q, def) => answers.shift() ?? def,
      choose: async (_q, _o, def) => def,
      enter: () => ({ done: new Promise<void>(() => {}), cancel() {} }),
      close() {},
    };
  }
  const host: Host = { platform: "linux", open: () => true, copy: () => true, run: () => 0, hasChrome: () => false, chromeProfiles: () => [] };

  test("installs the extension, pre-approves exactly that copy, and turns on Google sources", async () => {
    const root = tmp("setup");
    const home = join(root, "home");
    const cfg = defaultConfig(home);
    cfg.daemon.port = 1; // nothing listens there
    const db = openDatabase(join(home, "faber.sqlite"));
    const layout: Layout = { compiled: true, exe: "/x", command: ["/x"], brewPrefix: null, extensionSrc: fakeExtension(join(root, "src"), "0.1.0"), launcherSrc: null };
    const io = fakeIo();
    await runSetup({ io, host, layout, db, cfg }, { service: false, ai: false, extension: true, launcher: false, open: false });
    const ext = join(home, "extension");
    expect(existsSync(join(ext, "manifest.json"))).toBe(true);
    const approved = listExtensions(db).filter((e) => e.state === "approved").map((e) => e.id);
    expect(approved).toEqual([chromeExtensionId(realpathSync(ext))]);
    expect(getSettings(db).watchlist.filter((r) => ["gdocs", "gslides", "gsheets"].includes(r.id)).every((r) => r.enabled)).toBe(true);
    expect(io.lines.join("\n")).toContain("Load unpacked");

    // Running it again changes nothing and approves nothing new.
    await runSetup({ io: fakeIo(), host, layout, db, cfg }, { service: false, ai: false, extension: true, launcher: false, open: false });
    expect(listExtensions(db).filter((e) => e.state === "approved")).toHaveLength(1);
    db.close();
  });

  test("declining the Google sources leaves them off", async () => {
    const root = tmp("setup-no");
    const db = openDatabase(join(root, "faber.sqlite"));
    const cfg = defaultConfig(root);
    cfg.daemon.port = 1;
    const layout: Layout = { compiled: true, exe: "/x", command: ["/x"], brewPrefix: null, extensionSrc: null, launcherSrc: null };
    await runSetup({ io: fakeIo([false, false]), host, layout, db, cfg }, { service: false, ai: false, extension: false, launcher: false, open: false });
    expect(getSettings(db).watchlist.find((r) => r.id === "gdocs")!.enabled).toBe(false);
    db.close();
  });
});
