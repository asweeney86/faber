// Faber Launcher: the system-wide launcher for macOS (PRD P2).
//
// A menu-bar app (no Dock icon) that shows Faber's launcher in a floating panel
// when you press a global hotkey (⌥Space by default), from any app. The panel
// hosts the daemon's /launcher page, the same launcher as in the browser, so
// search, browsing projects and Ask behave identically. Links open in your
// default browser; Esc or clicking elsewhere hides the panel.
//
// The hotkey uses Carbon's RegisterEventHotKey, which needs no Accessibility
// permission. Change it in Faber's Settings → Shortcuts: the page passes the saved hotkey
// to the app, which re-registers it and remembers it in `defaults` (domain dev.faber.launcher).
// The defaults can also be set by hand:
//   defaults write dev.faber.launcher daemonURL http://127.0.0.1:7777
//   defaults write dev.faber.launcher hotkey "cmd+shift+space"   (modifiers: cmd, ctrl, option, shift)
//
// Flags (for scripts and tests):
//   --daemon <url>        use this daemon for this run
//   --show                show the panel right away
//   --login-item on|off   turn Open at login on or off (faber setup uses this)
//   --snapshot <png>      show the panel, save an image of it once loaded, and quit
//   --selftest            drive the app through its behaviours and print PASS/FAIL lines
//                         (packages/macos/app.test.ts runs it against a live daemon)

import Carbon.HIToolbox
import Cocoa
import ServiceManagement
import WebKit

// The app's own domain (its bundle id is dev.faber.launcher).
let defaults = UserDefaults.standard
let args = CommandLine.arguments

func argument(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// The daemon to show. Anything that isn't a plain http(s) URL falls back to the default.
func resolveDaemonURL(_ candidates: [String?]) -> URL {
    for text in candidates {
        guard let text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty,
              let url = URL(string: text.hasSuffix("/") ? String(text.dropLast()) : text),
              url.scheme == "http" || url.scheme == "https", url.host != nil,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { continue }
        // WebKit reports hosts in lower case; match it so the daemon checks compare equal.
        parts.host = parts.host?.lowercased()
        parts.scheme = parts.scheme?.lowercased()
        if let clean = parts.url { return clean }
    }
    return URL(string: "http://127.0.0.1:7777")!
}

let daemonURL = resolveDaemonURL([argument("--daemon"), defaults.string(forKey: "daemonURL")])
let launcherURL = daemonURL.appendingPathComponent("launcher")

/// Same scheme, host and port as the daemon: the only place the panel may show.
func isDaemon(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme?.lowercased() == daemonURL.scheme && url.host?.lowercased() == daemonURL.host && (url.port ?? defaultPort(url)) == (daemonURL.port ?? defaultPort(daemonURL))
}

func defaultPort(_ url: URL) -> Int { url.scheme == "https" ? 443 : 80 }

/// Where the panel goes on a screen: centred, a bit above the middle (like Spotlight), and
/// never larger than the screen's visible area or below its bottom edge.
func panelFrame(in f: NSRect) -> NSRect {
    let size = NSSize(width: max(320, min(1040, f.width - 40)), height: max(240, min(620, f.height - 40)))
    let y = max(f.minY + 20, f.maxY - size.height - f.height * 0.12)
    return NSRect(x: f.midX - size.width / 2, y: y, width: size.width, height: size.height)
}

/// "Open at login" registers this copy of the app; a copy in the build folder is replaced on
/// every build, so suggest installing it first.
func isInstalledLocation(_ path: String) -> Bool {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/")
}

/// How links are opened: the default browser (the self-test records them instead).
var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }

func htmlEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}

// MARK: - Hotkey

struct Hotkey {
    let keyCode: UInt32
    let modifiers: UInt32
    let label: String
    /// Canonical text ("cmd+shift+space"): the format the daemon stores (packages/shared/src/shortcuts.ts).
    let spec: String

    static let fallback = Hotkey(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey), label: "⌥Space", spec: "option+space")

    /// "option+space", "cmd+shift+k", "ctrl+f5"… Unknown input falls back to ⌥Space.
    static func parse(_ text: String?) -> Hotkey { parseStrict(text) ?? fallback }

    /// nil for anything that isn't one key plus modifiers (an F-key may stand alone).
    static func parseStrict(_ text: String?) -> Hotkey? {
        guard let text, !text.isEmpty else { return nil }
        var mods = Set<String>()
        var key: (code: UInt32, name: String)?
        for part in text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map({ String($0).trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "meta": mods.insert("cmd")
            case "ctrl", "control": mods.insert("ctrl")
            case "opt", "option", "alt": mods.insert("option")
            case "shift": mods.insert("shift")
            default:
                guard key == nil, let code = keyCodes[part] else { return nil }
                key = (code, part)
            }
        }
        guard let key, !mods.isEmpty || key.name.hasPrefix("f") && key.name.count > 1 else { return nil }
        let order: [(String, Int, String)] = [("cmd", cmdKey, "⌘"), ("ctrl", controlKey, "⌃"), ("option", optionKey, "⌥"), ("shift", shiftKey, "⇧")]
        var bits: UInt32 = 0
        var label = ""
        var spec: [String] = []
        for (name, bit, symbol) in order where mods.contains(name) {
            bits |= UInt32(bit)
            label += symbol
            spec.append(name)
        }
        spec.append(key.name)
        return Hotkey(keyCode: key.code, modifiers: bits, label: label + (keyLabels[key.name] ?? key.name.uppercased()), spec: spec.joined(separator: "+"))
    }

    static let keyLabels = ["space": "Space", "left": "←", "right": "→", "up": "↑", "down": "↓"]

    static let keyCodes: [String: UInt32] = {
        var m: [String: UInt32] = [
            "a": UInt32(kVK_ANSI_A), "b": UInt32(kVK_ANSI_B), "c": UInt32(kVK_ANSI_C), "d": UInt32(kVK_ANSI_D), "e": UInt32(kVK_ANSI_E),
            "f": UInt32(kVK_ANSI_F), "g": UInt32(kVK_ANSI_G), "h": UInt32(kVK_ANSI_H), "i": UInt32(kVK_ANSI_I), "j": UInt32(kVK_ANSI_J),
            "k": UInt32(kVK_ANSI_K), "l": UInt32(kVK_ANSI_L), "m": UInt32(kVK_ANSI_M), "n": UInt32(kVK_ANSI_N), "o": UInt32(kVK_ANSI_O),
            "p": UInt32(kVK_ANSI_P), "q": UInt32(kVK_ANSI_Q), "r": UInt32(kVK_ANSI_R), "s": UInt32(kVK_ANSI_S), "t": UInt32(kVK_ANSI_T),
            "u": UInt32(kVK_ANSI_U), "v": UInt32(kVK_ANSI_V), "w": UInt32(kVK_ANSI_W), "x": UInt32(kVK_ANSI_X), "y": UInt32(kVK_ANSI_Y),
            "z": UInt32(kVK_ANSI_Z),
            "0": UInt32(kVK_ANSI_0), "1": UInt32(kVK_ANSI_1), "2": UInt32(kVK_ANSI_2), "3": UInt32(kVK_ANSI_3), "4": UInt32(kVK_ANSI_4),
            "5": UInt32(kVK_ANSI_5), "6": UInt32(kVK_ANSI_6), "7": UInt32(kVK_ANSI_7), "8": UInt32(kVK_ANSI_8), "9": UInt32(kVK_ANSI_9),
            "space": UInt32(kVK_Space),
            "left": UInt32(kVK_LeftArrow), "right": UInt32(kVK_RightArrow), "up": UInt32(kVK_UpArrow), "down": UInt32(kVK_DownArrow),
        ]
        let f = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (i, code) in f.enumerated() { m["f\(i + 1)"] = UInt32(code) }
        return m
    }()
}

var hotkeyHandler: (() -> Void)?
let hotkeySignature = OSType(0x4641_4252) // "FABR"
var hotkeyRef: EventHotKeyRef?
var hotkeyHandlerInstalled = false

/// Register (or re-register) the global hotkey. The event handler is installed once.
func registerHotkey(_ hk: Hotkey) -> Bool {
    if !hotkeyHandlerInstalled {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            let got = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard got == noErr, id.signature == hotkeySignature else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { hotkeyHandler?() }
            return noErr
        }, 1, &spec, nil, nil)
        hotkeyHandlerInstalled = true
    }
    if let old = hotkeyRef { UnregisterEventHotKey(old); hotkeyRef = nil }
    let id = EventHotKeyID(signature: hotkeySignature, id: 1)
    return RegisterEventHotKey(hk.keyCode, hk.modifiers, id, GetApplicationEventTarget(), 0, &hotkeyRef) == noErr
}

// MARK: - Panel

/// A borderless panel that can still take keyboard focus.
///
/// Focus model: the panel is non-activating, so it can become key and take typing even if
/// macOS declines to activate the app (activation is only a request since macOS 14). We
/// still ask to activate, so the previous app's windows step back like with Spotlight, and
/// on hide we hand focus back with NSApp.hide (not after opening a link, where the browser
/// should come forward). Edit shortcuts are handled here too, so ⌘C/⌘V/⌘X/⌘A/⌘Z work
/// whether or not the app became active.
final class LauncherPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods.contains(.command), !mods.contains(.control), !mods.contains(.option), let key = event.charactersIgnoringModifiers?.lowercased() {
            var action: Selector?
            // Shift only for redo: ⌘⇧C and friends belong to the page (copy link…).
            let shift = mods.contains(.shift)
            switch key {
            case "c" where !shift: action = #selector(NSText.copy(_:))
            case "v" where !shift: action = #selector(NSText.paste(_:))
            case "x" where !shift: action = #selector(NSText.cut(_:))
            case "a" where !shift: action = #selector(NSText.selectAll(_:))
            case "z": action = shift ? Selector(("redo:")) : Selector(("undo:"))
            default: break
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var panel: LauncherPanel!
    var web: WKWebView!
    var status: NSStatusItem!
    var openItem: NSMenuItem!
    /// The page has been told which hotkey is registered since it last loaded.
    var hotkeyReported = false
    var hotkey = Hotkey.parse(defaults.string(forKey: "hotkey"))
    var loaded = false
    var loading = false
    var offlineShown = false
    var loadedAt = Date.distantPast
    /// Bumped on every load, so a watchdog from an earlier load can't cancel a later one.
    var generation = 0
    var snapshotPath = argument("--snapshot")

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu bar only, no Dock icon
        buildPanel()
        hotkeyHandler = { [weak self] in self?.toggle() }
        if !registerHotkey(hotkey) {
            NSLog("Faber Launcher: couldn't register \(hotkey.label); falling back to ⌥Space")
            hotkey = .fallback
            if !registerHotkey(hotkey) { NSLog("Faber Launcher: couldn't register ⌥Space either; use the menu bar icon") }
        }
        if let want = argument("--login-item") { setLoginItem(want == "on") }
        buildMenu()
        buildMainMenu()
        load()
        if args.contains("--selftest") {
            selfTest = SelfTest(app: self)
            selfTest?.start()
        } else if args.contains("--show") || snapshotPath != nil {
            show()
        }
    }

    var selfTest: SelfTest?

    func buildPanel() {
        let size = NSSize(width: 1040, height: 620)
        panel = LauncherPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "faber")
        web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground") // the page draws its own (theme) background
        web.navigationDelegate = self
        web.allowsLinkPreview = false
        web.unregisterDraggedTypes() // dropping a link or file mustn't navigate the panel away
        web.autoresizingMask = [.width, .height]

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = 16
        container.layer?.masksToBounds = true
        container.addSubview(web)
        panel.contentView = container
    }

    func buildMenu() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = status.button {
            button.image = NSImage(systemSymbolName: "bookmark.fill", accessibilityDescription: "Faber")
            button.toolTip = "Faber Launcher (\(hotkey.label))"
        }
        let menu = NSMenu()
        openItem = menu.addItem(withTitle: "Open launcher  \(hotkey.label)", action: #selector(showFromMenu), keyEquivalent: "")
        menu.addItem(withTitle: "Open Faber", action: #selector(openApp), keyEquivalent: "")
        menu.addItem(.separator())
        let login = NSMenuItem(title: "Open at login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Faber Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) { item.target = self }
        status.menu = menu
    }

    /// An Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z reach the search box. Never shown (no Dock, no menu bar).
    func buildMainMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    func load() {
        hotkeyReported = false
        loaded = false
        loading = true
        offlineShown = false
        generation += 1
        let gen = generation
        var page = URLComponents(url: launcherURL, resolvingAgainstBaseURL: false)!
        page.queryItems = [URLQueryItem(name: "hotkey", value: hotkey.label)]
        web.load(URLRequest(url: page.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
        // WebKit doesn't always report a refused connection; if the page isn't up soon, say why.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, self.generation == gen, self.loading, !self.loaded else { return }
            self.showOffline(URLError(.cannotConnectToHost))
        }
    }

    /// The page was loaded a while ago: is the daemon still there? Reload if it went away
    /// (shows the offline page) or if the page is old (picks up a daemon upgrade).
    /// Is the daemon still there? A HEAD of the launcher page: cheap, and unlike /api/status it
    /// never waits on the AI provider, so a busy daemon isn't mistaken for a dead one.
    func checkStale() {
        guard loaded else { return }
        var req = URLRequest(url: launcherURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        req.httpMethod = "HEAD"
        let gen = generation
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async {
                guard let self, self.generation == gen, !ok else { return }
                self.load() // fails fast and shows the offline page, or picks up a restarted daemon
            }
        }.resume()
    }

    // MARK: show / hide

    func toggle() { panel.isVisible ? hide() : show() }

    func show() {
        // On the screen with the mouse, a third of the way down (like Spotlight).
        // Sized to fit small screens too.
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first {
            panel.setFrame(panelFrame(in: screen.visibleFrame), display: false)
        }
        if !loaded && !loading { load() } else { checkStale() }
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(web)
        web.evaluateJavaScript("window.__faberShow && window.__faberShow()")
    }

    /// `restoreFocus`: hand focus back to the app you were in. Not after opening a link,
    /// where the browser should come forward instead.
    func hide(restoreFocus: Bool = true) {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        if restoreFocus { NSApp.hide(nil) }
        // An old page picks up daemon upgrades, reloaded while hidden so it never interrupts typing.
        if loaded, Date().timeIntervalSince(loadedAt) > 30 * 60 { load() }
    }

    @objc func showFromMenu() { show() }

    @objc func openApp() { NSWorkspace.shared.open(daemonURL) }

    @objc func toggleLogin(_ item: NSMenuItem) {
        if SMAppService.mainApp.status != .enabled, !isInstalledLocation(Bundle.main.bundlePath) {
            let alert = NSAlert()
            alert.messageText = "Move Faber Launcher to Applications first?"
            alert.informativeText = "This copy is in \((Bundle.main.bundlePath as NSString).deletingLastPathComponent), which each build replaces. Move it to /Applications (or ~/Applications), open it from there, then turn on Open at login."
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Turn On Anyway")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() != .alertSecondButtonReturn { return }
        }
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            NSLog("Faber Launcher: login item: \(error)")
        }
        item.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    /// For `faber setup`, which has already put the app in ~/Applications.
    func setLoginItem(_ on: Bool) {
        let enabled = SMAppService.mainApp.status == .enabled
        do {
            if on, !enabled { try SMAppService.mainApp.register() }
            if !on, enabled { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("Faber Launcher: login item: \(error)")
        }
        if on, SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    }

    // Clicking another app hides the launcher.
    func windowDidResignKey(_ notification: Notification) {
        if snapshotPath == nil { hide() }
    }

    // MARK: messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        // Only the daemon's own page may open things. Closing (just hiding the panel) is fine
        // from any page in it: that includes the offline page, even mid-retry.
        let origin = message.frameInfo.securityOrigin
        let fromDaemon = origin.protocol == daemonURL.scheme && origin.host == daemonURL.host
            && (origin.port == 0 ? defaultPort(daemonURL) : origin.port) == (daemonURL.port ?? defaultPort(daemonURL))
        guard fromDaemon || type == "close" else { return }
        switch type {
        case "open":
            // Only web links: never file:, javascript: or app URLs from page content.
            if let s = body["url"] as? String, let url = URL(string: s), url.scheme == "http" || url.scheme == "https" {
                openURL(url)
                hide(restoreFocus: false)
            }
        case "close":
            hide()
        case "hotkey":
            setHotkey(body["value"] as? String)
        default:
            break
        }
    }

    // MARK: hotkey changes (Settings → Shortcuts, through the daemon)

    /// The page passes the hotkey saved in Faber's settings on every settings check. nil = none
    /// saved: keep what this Mac already has (the default, or an old `defaults write`).
    /// Replies once per page load, and after every change, with what's actually registered.
    func setHotkey(_ value: String?) {
        var ok = true
        if let value, let want = Hotkey.parseStrict(value), want.spec != hotkey.spec {
            if registerHotkey(want) {
                hotkey = want
                // Remembered here too, so the next launch has it before the daemon answers.
                if selfTest == nil { defaults.set(want.spec, forKey: "hotkey") }
                status.button?.toolTip = "Faber Launcher (\(hotkey.label))"
                openItem.title = "Open launcher  \(hotkey.label)"
            } else {
                NSLog("Faber Launcher: couldn't register \(want.label); keeping \(hotkey.label)")
                _ = registerHotkey(hotkey)
                ok = false
            }
        } else if hotkeyReported {
            return
        }
        hotkeyReported = true
        let wanted = value.flatMap { Hotkey.parseStrict($0)?.label } ?? hotkey.label
        let result: [String: Any] = ["label": hotkey.label, "spec": hotkey.spec, "ok": ok, "wanted": wanted]
        guard let data = try? JSONSerialization.data(withJSONObject: result), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__faberHotkeyResult && window.__faberHotkeyResult(\(json))")
    }

    // MARK: loading

    /// The panel only ever shows the daemon's pages (and our offline page). A link to anywhere
    /// else opens in the browser; anything else (a dropped file, a script redirect) is refused.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if isDaemon(url) || url?.absoluteString == "about:blank" || (url == nil && offlineShown) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated, let url, url.scheme == "http" || url.scheme == "https" {
            openURL(url)
            hide(restoreFocus: false)
        }
    }

    /// WebKit's content process died: start over rather than show a blank panel.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        loading = false
        if panel.isVisible { load() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let isLauncher = isDaemon(webView.url) && webView.url?.path == launcherURL.path
        if isLauncher {
            loaded = true
            loading = false
            loadedAt = Date()
        }
        // Snapshot only what we meant to show: the launcher, or the offline page.
        if let path = snapshotPath, isLauncher || offlineShown {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.snapshot(to: path) }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showOffline(error) }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showOffline(error) }

    /// The daemon isn't running: say so, in the panel, with the way to start it.
    func showOffline(_ error: Error) {
        // A load we replaced ourselves isn't a failure.
        if (error as NSError).code == NSURLErrorCancelled { return }
        loaded = false
        loading = false
        offlineShown = true
        let html = """
        <html><body style="margin:0;font:15px -apple-system;background:#1e1e2e;color:#cdd6f4;display:flex;align-items:center;justify-content:center;height:100vh">
        <div style="max-width:440px;text-align:center"><h2 style="margin:0 0 8px">Faber isn’t running</h2>
        <p style="color:#a6adc8;line-height:1.5">Couldn’t reach \(htmlEscape(daemonURL.absoluteString)). Start it from the project folder with <code style="background:#313244;padding:2px 6px;border-radius:5px">bun faber serve</code>, then press \(htmlEscape(hotkey.label)) again.</p>
        <p style="color:#7f849c;font-size:12px">Esc to close</p></div>
        <script>addEventListener('keydown',e=>{if(e.key==='Escape')webkit.messageHandlers.faber.postMessage({type:'close'})})</script></body></html>
        """
        web.loadHTMLString(html, baseURL: nil) // didFinish takes the snapshot once it has rendered
    }

    var snapshotTaken = false

    func snapshot(to path: String) {
        guard !snapshotTaken else { return }
        snapshotTaken = true
        web.takeSnapshot(with: nil) { image, _ in
            if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
                print("snapshot: \(path)")
            } else {
                print("snapshot failed")
            }
            NSApp.terminate(nil)
        }
    }
}

// MARK: - Self-test

/// `--selftest`: exercises the real app (hotkey events, keystrokes through AppKit into the
/// page, the bridge, navigation rules, daemon restarts, a web process crash) and prints one
/// PASS/FAIL line per check. "PAUSE <what>" lines wait for the harness to act and reply on stdin.
@MainActor final class SelfTest {
    let app: AppDelegate
    var failures = 0
    var opened: [URL] = []

    init(app: AppDelegate) { self.app = app }

    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        print("\(ok ? "PASS" : "FAIL") \(name)\(ok ? "" : " — \(detail())")")
        fflush(stdout)
        if !ok { failures += 1 }
    }

    func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }

    @MainActor func until(_ timeout: Double = 6, _ cond: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await cond() { return true }
            await sleep(0.1)
        }
        return await cond()
    }

    /// Runs JS in the page and returns its result as a string ("" on error, or after 2s
    /// without an answer, e.g. while the web process is restarting).
    @MainActor func js(_ code: String) async -> String {
        await withCheckedContinuation { c in
            var done = false
            let finish = { (value: String) in
                if done { return }
                done = true
                c.resume(returning: value)
            }
            app.web.evaluateJavaScript("String((() => { try { return \(code) } catch (e) { return 'error: ' + e } })())") { r, _ in
                finish((r as? String) ?? "")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish("") }
        }
    }

    /// The hotkey as Carbon delivers it, through the real registered handler.
    func pressHotkey(signature: OSType = hotkeySignature) {
        var event: EventRef?
        CreateEvent(nil, OSType(kEventClassKeyboard), UInt32(kEventHotKeyPressed), 0, EventAttributes(kEventAttributeNone), &event)
        var id = EventHotKeyID(signature: signature, id: 1)
        SetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), MemoryLayout<EventHotKeyID>.size, &id)
        SendEventToEventTarget(event, GetApplicationEventTarget())
        ReleaseEvent(event)
    }

    /// A key press delivered through NSApp, as if typed (key equivalents included).
    func key(_ chars: String, code: UInt16 = 0, _ mods: NSEvent.ModifierFlags = []) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: app.panel.windowNumber, context: nil, characters: chars,
                                           charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { continue }
            NSApp.sendEvent(e)
        }
    }

    func type(_ text: String) async {
        for ch in text {
            key(String(ch))
            await sleep(0.02)
        }
    }

    /// Waits for the harness: prints PAUSE and reads one line from stdin.
    func pause(_ what: String) async {
        print("PAUSE \(what)")
        fflush(stdout)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async { _ = readLine(); c.resume() }
        }
    }

    @MainActor func shown() async -> Bool {
        await until {
            guard self.app.panel.isVisible, self.app.loaded else { return false }
            return await self.js("document.activeElement?.dataset?.testid") == "launcher-input"
        }
    }

    func start() {
        openURL = { [weak self] url in self?.opened.append(url) }
        Task { @MainActor in
            await self.run()
            print(self.failures == 0 ? "SELFTEST OK" : "SELFTEST FAILED (\(self.failures))")
            fflush(stdout)
            exit(self.failures == 0 ? 0 : 1)
        }
    }

    @MainActor func run() async {
        // Pure helpers.
        for f in [NSRect(x: 0, y: 0, width: 1280, height: 680), NSRect(x: 0, y: 25, width: 800, height: 575), NSRect(x: 0, y: 0, width: 2560, height: 1415)] {
            let r = panelFrame(in: f)
            check("panel fits a \(Int(f.width))×\(Int(f.height)) screen", f.contains(r), "\(r) not in \(f)")
        }
        check("build folder isn't an install location", !isInstalledLocation("/Users/x/dev/faber/packages/macos/build/Faber Launcher.app"))
        check("/Applications is an install location", isInstalledLocation("/Applications/Faber Launcher.app"))
        check("a blank daemonURL falls back to the default", resolveDaemonURL(["", nil]).absoluteString == "http://127.0.0.1:7777")
        check("a non-http daemonURL is ignored", resolveDaemonURL(["file:///etc", "javascript:alert(1)"]).absoluteString == "http://127.0.0.1:7777")
        check("a daemonURL host is matched case-insensitively", resolveDaemonURL(["http://LOCALHOST:7777/"]).absoluteString == "http://localhost:7777")
        check("hotkey text parses", Hotkey.parse("cmd+shift+k").label == "⌘⇧K" && Hotkey.parse("nonsense").label == "⌥Space")
        check("hotkey text is made canonical", Hotkey.parse("Shift + Command + Space").spec == "cmd+shift+space")
        check("digits, F-keys and arrows parse", Hotkey.parse("ctrl+option+7").label == "⌃⌥7" && Hotkey.parse("f5").label == "F5" && Hotkey.parse("cmd+left").label == "⌘←")
        check("a bare letter or two keys is refused", Hotkey.parseStrict("k") == nil && Hotkey.parseStrict("cmd+k+j") == nil && Hotkey.parseStrict("cmd++k") == nil)

        // 1. The hotkey shows the panel, focused on the search box.
        check("starts hidden", !app.panel.isVisible)
        pressHotkey(signature: OSType(0x4F54_4852)) // someone else's hotkey
        await sleep(0.4)
        check("another app's hotkey event is ignored", !app.panel.isVisible)
        pressHotkey()
        check("hotkey shows the launcher with the search box focused", await shown(), "visible=\(app.panel.isVisible) loaded=\(app.loaded)")
        check("the panel is the key window", app.panel.isKeyWindow)
        if let screen = app.panel.screen { check("the panel is on screen", screen.visibleFrame.contains(app.panel.frame)) }
        check("the page shows the app's hotkey", (await js("document.querySelector('[data-testid=launcher]').textContent.includes('\(app.hotkey.label)')")) == "true")

        // 2. Typing goes through AppKit into the page; results appear.
        await type("okrs")
        check("typed text reaches the search box", await until { await self.js("document.activeElement.value") == "okrs" }, "value")
        // (Not first in Recent, so this only passes once the search has run.)
        check("search results replace Recent", await until { (await self.js("document.querySelector('[data-testid=launcher-item]')?.textContent ?? ''")).contains("OKRs") })
        if let shot = argument("--selftest-shots") { await snapshot(to: shot + "/typed.png") }

        // 3. Edit shortcuts: select all + paste replaces the query; copy copies.
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("frankfurt", forType: .string)
        key("a", code: 0, .command)
        key("v", code: 9, .command)
        check("⌘A then ⌘V pastes into the search box", await until { await self.js("document.activeElement.value") == "frankfurt" }, "value")
        key("a", code: 0, .command)
        NSPasteboard.general.clearContents()
        key("c", code: 8, .command)
        check("⌘C copies the selection", await until { NSPasteboard.general.string(forType: .string) == "frankfurt" }, NSPasteboard.general.string(forType: .string) ?? "nil")

        // ⌘⇧C is the page's "copy link", not the Edit menu's copy.
        key("a", code: 0, .command)
        await type("okrs")
        _ = await until { (await self.js("document.querySelector('[data-testid=launcher-item]')?.textContent ?? ''")).contains("OKRs") }
        NSPasteboard.general.clearContents()
        key("C", code: 8, [.command, .shift])
        check("⌘⇧C copies the selected doc's link", await until { (NSPasteboard.general.string(forType: .string) ?? "").hasPrefix("http") }, NSPasteboard.general.string(forType: .string) ?? "nil")

        // 4. Enter opens the selected doc in the browser and hides without stealing focus back.
        key("a", code: 0, .command)
        await type("rate limit")
        _ = await until { (await self.js("document.querySelector('[data-testid=launcher-item]')?.textContent ?? ''")).contains("Rate Limit Design") }
        await sleep(0.3)
        key("\r", code: 36)
        check("Enter opens the doc in the browser", await until { self.opened.contains { $0.host == "docs.google.com" } }, "\(self.opened)")
        check("…and hides the panel", await until { !self.app.panel.isVisible })
        check("…leaving focus for the browser (app not hidden)", !NSApp.isHidden)

        // 5. Each show starts fresh; Esc clears, then hides and hands focus back.
        pressHotkey()
        check("shown again", await shown())
        check("the query starts empty", await js("document.activeElement.value") == "")
        await type("xyz")
        key("\u{1b}", code: 53)
        check("Esc clears the query first", await until { await self.js("document.activeElement.value") == "" })
        key("\u{1b}", code: 53)
        check("a second Esc hides the panel", await until { !self.app.panel.isVisible })
        check("…and hands focus back to the previous app", await until { NSApp.isHidden || !NSApp.isActive })

        // 6. The hotkey toggles.
        pressHotkey()
        check("hotkey shows", await shown())
        pressHotkey()
        check("hotkey again hides", await until { !self.app.panel.isVisible })

        // 7. The panel never leaves the daemon's pages.
        pressHotkey()
        _ = await shown()
        let before = opened.count
        _ = await js("(location.href = 'https://example.com/elsewhere', 'ok')")
        await sleep(0.8)
        check("a script redirect away from the daemon is refused", app.web.url.map(isDaemon) == true && app.web.url?.path == "/launcher", app.web.url?.absoluteString ?? "nil")
        _ = await js("(location.href = 'file:///etc/hosts', 'ok')")
        await sleep(0.8)
        check("a file: navigation is refused", app.web.url?.scheme == "http", app.web.url?.absoluteString ?? "nil")
        check("…and neither opened anything", opened.count == before, "\(opened)")
        _ = await js("(() => { const a = document.createElement('a'); a.href = 'https://example.com/clicked'; document.body.append(a); a.click(); return 'ok' })()")
        check("a clicked outside link opens in the browser instead", await until { self.opened.contains { $0.absoluteString == "https://example.com/clicked" } }, "\(self.opened)")
        check("…while the panel stays on the launcher", app.web.url?.path == "/launcher")

        // 8. The bridge: only http(s), only from the daemon's main frame.
        pressHotkey()
        _ = await shown()
        let n = opened.count
        _ = await js("(webkit.messageHandlers.faber.postMessage({ type: 'open', url: 'file:///etc/hosts' }), webkit.messageHandlers.faber.postMessage({ type: 'open', url: 'javascript:alert(1)' }), 'ok')")
        _ = await js("(() => { const f = document.createElement('iframe'); f.src = '/launcher?frame=1'; f.onload = () => f.contentWindow.webkit.messageHandlers.faber.postMessage({ type: 'open', url: 'https://evil.example/' }); document.body.append(f); return 'ok' })()")
        await sleep(1.5)
        check("non-web URLs and subframe messages are ignored", opened.count == n, "\(opened.suffix(from: n))")
        check("…and the panel is still showing", app.panel.isVisible)

        // 8b. Settings → Shortcuts: the page hands over a new hotkey, the app switches to it.
        let original = app.hotkey.spec
        _ = await js("(() => { const f = document.createElement('iframe'); f.src = '/launcher?frame=2'; f.onload = () => f.contentWindow.webkit.messageHandlers.faber.postMessage({ type: 'hotkey', value: 'cmd+shift+8' }); document.body.append(f); return 'ok' })()")
        await sleep(1)
        check("a subframe can't change the hotkey", app.hotkey.spec == original, app.hotkey.spec)
        _ = await js("(window.__hk = null, window.__faberHotkeyResult = (r) => { window.__hk = r }, webkit.messageHandlers.faber.postMessage({ type: 'hotkey', value: 'cmd+shift+9' }), 'ok')")
        check("the page can change the hotkey", await until { self.app.hotkey.spec == "cmd+shift+9" }, app.hotkey.spec)
        check("…and the menu shows it", app.openItem.title.hasSuffix("⌘⇧9"), app.openItem.title)
        check("…and the page hears what's registered", await until { await self.js("window.__hk && window.__hk.label + ' ' + window.__hk.ok") == "⌘⇧9 true" })
        app.hide()
        pressHotkey()
        check("the new hotkey shows the launcher", await shown())
        _ = await js("(webkit.messageHandlers.faber.postMessage({ type: 'hotkey', value: '\(original)' }), 'ok')")
        check("…and it can be changed back", await until { self.app.hotkey.spec == original }, app.hotkey.spec)

        // 9. The daemon goes away, then comes back.
        app.hide()
        await pause("stop-daemon")
        pressHotkey()
        check("with the daemon stopped, showing says it isn't running", await until(8) { (await self.js("document.body.innerText")).contains("isn’t running") }, "not shown")
        key("\u{1b}", code: 53)
        check("Esc closes the offline page", await until { !self.app.panel.isVisible })
        await pause("start-daemon")
        pressHotkey()
        check("with the daemon back, the launcher returns", await shown())

        // 10. The web content process crashes: the panel reloads rather than stay blank.
        // (SIGKILL the WebContent process, as a crash would; its pid is WebKit-private.)
        let pidKey = Selector(("_webProcessIdentifier"))
        if app.web.responds(to: pidKey), let pid = (app.web.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value, pid > 0 {
            Darwin.kill(pid, SIGKILL)
            await sleep(1)
            check("after a web process crash the launcher reloads", await until(10) { await self.shown() })
        } else {
            print("SKIP web process crash (no web process id)")
        }
        app.hide()
    }

    @MainActor func snapshot(to path: String) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            app.web.takeSnapshot(with: nil) { image, _ in
                if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                c.resume()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
