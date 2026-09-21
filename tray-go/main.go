package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gogpu/systray"
)

var version = "0.2.0"

// Compiled in at package time via -X main.pluginCatalogURL=... (see
// package-windows.ps1 / package-macos.sh), same mechanism as
// updater.go's updateFeedURL. Empty by default so a dev build with no
// ldflag simply has no catalog configured, same as before this existed.
var pluginCatalogURL string

// An explicit MEMORYLANE_PLUGIN_CATALOG_URL in the tray's own environment
// always wins over the compiled-in default - this is what let us point a
// packaged build at a local dev catalog for testing earlier, and lets
// anyone self-hosting a mirror or a beta channel override it the same way.
func resolvedPluginCatalogURL() string {
	if explicit := os.Getenv("MEMORYLANE_PLUGIN_CATALOG_URL"); explicit != "" {
		return explicit
	}
	if pluginCatalogURL != "" {
		return pluginCatalogURL
	}
	return defaultReleaseURL("plugins/v1/stable/%s/catalog.json")
}

// win32-x64/darwin-arm64, matching the plugin/update feed URL path
// convention everywhere else (scripts/build-plugin-repository.mjs,
// publish-release.mjs) - "" for anything else, since Intel Mac and other
// platforms aren't a supported release target yet.
func hostReleasePlatform() string {
	var goos string
	switch runtime.GOOS {
	case "windows":
		goos = "win32"
	case "darwin":
		goos = "darwin"
	default:
		return ""
	}
	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return ""
	}
	if goos == "win32" && arch != "x64" {
		return ""
	}
	if goos == "darwin" && arch != "arm64" {
		return ""
	}
	return goos + "-" + arch
}

// Only reached when there's no compiled-in ldflag value at all (pluginCatalogURL/
// updateFeedURL are "" - a `go run .`/plain `go build` with no -X, not a real
// packaged build, where package-windows.ps1/package-macos.sh always pass one
// explicitly). Without this, running the tray straight from source has no
// catalog and no update feed configured at all, even though the real hosted
// ones are perfectly reachable - this fills in the same default a packaged
// build for this host would have compiled in.
func defaultReleaseURL(pathTemplate string) string {
	platform := hostReleasePlatform()
	if platform == "" {
		return ""
	}
	return "https://memorylaneapp.org/" + fmt.Sprintf(pathTemplate, platform)
}

type config struct {
	Port                int  `json:"port"`
	LaunchAtLogin       bool `json:"launchAtLogin"`
	OpenBrowserAtLaunch bool `json:"openBrowserAtLaunch"`
}

type supervisor struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	state      string
	port       int
	token      string
	controlURL string
	logFile    *os.File
	onState    func(string)
	// Only set on the real tray's supervisor - runSmokeTest's own supervisor
	// wants to handle a startup failure itself (print, return a code) rather
	// than have fail() show a dialog and os.Exit from under it.
	exitOnFailure bool
}

var (
	sup                *supervisor
	menuState          *systray.MenuItem
	menuLogin          *systray.MenuItem
	menuOpenAtRun      *systray.MenuItem
	menuUpdate         *systray.MenuItem
	tray               *systray.SystemTray
	updateControlClose func()
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--smoke-test" {
		os.Exit(runSmokeTest())
	}
	if err := acquireSingleInstance(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	sup = &supervisor{state: "stopped", exitOnFailure: true}
	onReady()
	if err := tray.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	onExit()
}

func runSmokeTest() int {
	cfg := loadConfig()
	testSupervisor := &supervisor{state: "stopped", port: cfg.Port}
	started := time.Now()
	go testSupervisor.start(cfg.Port)
	if !testSupervisor.waitForState("running", 30*time.Second) {
		fmt.Fprintf(os.Stderr, "server did not reach running state (state=%s)\n", testSupervisor.currentState())
		testSupervisor.stop()
		return 1
	}
	startup := time.Since(started)
	testSupervisor.stop()
	if !testSupervisor.waitForState("stopped", 10*time.Second) {
		fmt.Fprintf(os.Stderr, "server did not stop (state=%s)\n", testSupervisor.currentState())
		return 1
	}
	fmt.Printf("{\"serverStartupMs\":%d,\"stoppedCleanly\":true}\n", startup.Milliseconds())
	return 0
}

func (s *supervisor) currentState() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *supervisor) waitForState(want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.currentState() == want {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return s.currentState() == want
}

func onReady() {
	cfg := loadConfig()
	sup.port = cfg.Port
	// Opens exactly once per launch, the first time the server actually
	// reaches "running" - not on every state change (a crash-and-manual-relaunch
	// mid-session shouldn't keep popping new tabs). This is the tray's own
	// concern, separate from the server's own auto-open logic (server.ts) -
	// the tray always passes MEMORYLANE_NO_OPEN=1 when it spawns the server
	// (see start() below) specifically so the two never both fire. A plain
	// `npm run dev`/`node dist/server.js` outside the tray is unaffected
	// either way and keeps using its own auto-open behavior as before.
	openedThisLaunch := false
	sup.onState = func(state string) {
		updateMenu(state)
		if state == "running" && cfg.OpenBrowserAtLaunch && !openedThisLaunch {
			openedThisLaunch = true
			_ = openBrowser(fmt.Sprintf("http://127.0.0.1:%d", sup.port))
		}
	}
	openMemoryLane := func() {
		go func() {
			state := sup.currentState()
			if state == "stopped" || state == "error" {
				go sup.start(cfg.Port)
			}
			if state != "running" && !sup.waitForState("running", 30*time.Second) {
				return
			}
			_ = openBrowser(fmt.Sprintf("http://127.0.0.1:%d", sup.port))
		}()
	}
	menu := systray.NewMenu()
	menu.Add("Open MemoryLane", openMemoryLane)
	menu.AddSeparator()
	menuState = menu.Add("MemoryLane stopped", nil)
	menuState.SetDisabled(true)
	versionItem := menu.Add("Version "+version, nil)
	versionItem.SetDisabled(true)
	menu.AddSeparator()
	loginEnabled := launchAtLoginEnabled()
	menuLogin = menu.AddCheckbox("Launch MemoryLane at login", loginEnabled, func() {
		enable := !menuLogin.IsChecked()
		if err := setLaunchAtLogin(enable); err == nil {
			cfg.LaunchAtLogin = enable
			menuLogin.SetChecked(enable)
			_ = saveConfig(cfg)
		}
	})
	menuOpenAtRun = menu.AddCheckbox("Open MemoryLane in Browser at Launch", cfg.OpenBrowserAtLaunch, func() {
		enable := !menuOpenAtRun.IsChecked()
		cfg.OpenBrowserAtLaunch = enable
		menuOpenAtRun.SetChecked(enable)
		_ = saveConfig(cfg)
	})
	menu.AddSeparator()
	if sup.token == "" {
		tokenBytes := make([]byte, 32)
		if _, err := rand.Read(tokenBytes); err != nil {
			showFatalError("MemoryLane", "Could not initialize desktop security")
			tray.Remove()
			return
		}
		sup.token = base64.RawURLEncoding.EncodeToString(tokenBytes)
	}
	updater := newCoreUpdater(func(label string, enabled bool) {
		menuUpdate.SetLabel(label)
		menuUpdate.SetDisabled(!enabled)
	})
	menuUpdate = menu.Add("Check for Updates", func() { go updater.activate(sup, tray) })
	if controlURL, closeControl, err := startUpdateControlServer(updater, sup, sup.token); err == nil {
		sup.controlURL, updateControlClose = controlURL, closeControl
	}
	go updater.start()
	menu.AddSeparator()
	menu.Add("Quit", func() { tray.Remove() })

	tray = systray.New()
	setTrayIcon(tray)
	tray.SetTooltip("MemoryLane").SetMenu(menu).OnDoubleClick(openMemoryLane).Show()
	updateMenu("stopped")
	writeReadyMarker()

	// Always start on tray launch - there's no more "Start Server" menu item
	// for a person to click instead, and a tray icon that isn't running the
	// server isn't doing its job. MEMORYLANE_TRAY_NO_AUTOSTART remains an
	// escape hatch for tests that want the tray UI up without a live server.
	if os.Getenv("MEMORYLANE_TRAY_NO_AUTOSTART") != "1" {
		go sup.start(cfg.Port)
	}
}

func onExit() {
	if updateControlClose != nil {
		updateControlClose()
	}
	if sup != nil {
		sup.stop()
	}
	releaseSingleInstance()
}

func updateMenu(state string) {
	if menuState == nil {
		return
	}
	label := map[string]string{
		"stopped":  "MemoryLane stopped",
		"starting": "MemoryLane starting...",
		"running":  fmt.Sprintf("MemoryLane running on port %d", sup.port),
		"stopping": "MemoryLane stopping...",
		"error":    "MemoryLane failed to start",
	}[state]
	menuState.SetLabel(label)
	tray.SetTooltip(label)
}

func (s *supervisor) setState(state string) {
	s.mu.Lock()
	s.state = state
	callback := s.onState
	s.mu.Unlock()
	if callback != nil {
		callback(state)
	}
}

func (s *supervisor) start(port int) {
	s.mu.Lock()
	if s.cmd != nil {
		s.mu.Unlock()
		return
	}
	s.port = port
	s.mu.Unlock()
	s.setState("starting")

	runtimeDir, err := resolveRuntimeDir()
	if err != nil {
		s.fail(err)
		return
	}
	node := filepath.Join(runtimeDir, nodeBinaryName())
	server := filepath.Join(runtimeDir, "dist", "server.js")
	if _, err = os.Stat(node); err != nil {
		s.fail(fmt.Errorf("runtime executable missing: %s", node))
		return
	}
	if _, err = os.Stat(server); err != nil {
		s.fail(fmt.Errorf("server missing: %s", server))
		return
	}

	if s.token == "" {
		tokenBytes := make([]byte, 32)
		if _, err = rand.Read(tokenBytes); err != nil {
			s.fail(err)
			return
		}
		s.token = base64.RawURLEncoding.EncodeToString(tokenBytes)
	}
	cmd := exec.Command(node, server)
	cmd.Dir = runtimeDir
	cmd.Env = append(os.Environ(),
		"MEMORYLANE_PORT="+strconv.Itoa(port),
		"MEMORYLANE_NO_OPEN=1",
		"MEMORYLANE_DESKTOP_PARENT_PID="+strconv.Itoa(os.Getpid()),
		"MEMORYLANE_DESKTOP_TOKEN="+s.token,
		"MEMORYLANE_DESKTOP_CONTROL_URL="+s.controlURL,
	)
	if plugins := bundledPluginsDir(); plugins != "" {
		cmd.Env = append(cmd.Env, "MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY="+plugins)
	}
	if catalogURL := resolvedPluginCatalogURL(); catalogURL != "" {
		cmd.Env = append(cmd.Env, "MEMORYLANE_PLUGIN_CATALOG_URL="+catalogURL)
	}
	configureChildProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.fail(err)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		s.fail(err)
		return
	}
	logPath := filepath.Join(appDataDir(), "tray.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0700)
	logFile, _ := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)

	s.mu.Lock()
	s.cmd, s.logFile = cmd, logFile
	s.mu.Unlock()
	if err = cmd.Start(); err != nil {
		s.mu.Lock()
		s.cmd = nil
		s.mu.Unlock()
		s.fail(err)
		return
	}
	go s.consume(stdout)
	go s.consume(stderr)
	err = cmd.Wait()
	s.mu.Lock()
	wasStopping := s.state == "stopping"
	s.cmd = nil
	if s.logFile != nil {
		_ = s.logFile.Close()
		s.logFile = nil
	}
	s.mu.Unlock()
	if err != nil && !wasStopping {
		s.setState("error")
	} else {
		s.setState("stopped")
	}
}

func (s *supervisor) consume(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		s.mu.Lock()
		if s.logFile != nil {
			_, _ = fmt.Fprintln(s.logFile, line)
		}
		state := s.state
		s.mu.Unlock()
		if state == "starting" && strings.Contains(line, "Server listening") {
			s.setState("running")
		}
	}
}

func (s *supervisor) stop() {
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	s.setState("stopping")
	_ = terminateProcessTree(cmd)
}

// Only ever reached from a *startup* failure (runtime missing, spawn error,
// etc. - see the call sites in start()) - a crash after the server was
// already running just sets state "error" directly, no dialog, since the
// tray itself is still a perfectly usable way to see that and (once relaunched)
// try again. A startup failure is different: with no more "Start Server" menu
// item to retry from, a dead tray icon with only a hard-to-notice disabled
// menu label as its only signal isn't good enough - show it and exit instead.
func (s *supervisor) fail(err error) {
	logPath := filepath.Join(appDataDir(), "tray.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0700)
	f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if f != nil {
		_, _ = fmt.Fprintf(f, "%s: %v\n", time.Now().Format(time.RFC3339), err)
		_ = f.Close()
	}
	s.setState("error")
	if s.exitOnFailure {
		showFatalError("MemoryLane could not start", err.Error())
		os.Exit(1)
	}
}

func loadConfig() config {
	cfg := config{Port: 4280, OpenBrowserAtLaunch: true}
	data, err := os.ReadFile(filepath.Join(appDataDir(), "desktop-config.json"))
	if err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	if value := os.Getenv("MEMORYLANE_PORT"); value != "" {
		if port, err := strconv.Atoi(value); err == nil {
			cfg.Port = port
		}
	}
	return cfg
}

func saveConfig(cfg config) error {
	path := filepath.Join(appDataDir(), "desktop-config.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func appDataDir() string {
	if override := os.Getenv("MEMORYLANE_TRAY_DATA_DIR"); override != "" {
		return override
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "MemoryLane")
}

func resolveRuntimeDir() (string, error) {
	if override := os.Getenv("MEMORYLANE_RUNTIME_DIR"); override != "" {
		return filepath.Abs(override)
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	workingDir, _ := os.Getwd()
	candidates := []string{
		filepath.Join(workingDir, "tray-go", "runtime"),
		filepath.Join(workingDir, "runtime"),
		filepath.Join(filepath.Dir(executable), "runtime"),
		filepath.Join(filepath.Dir(executable), "..", "runtime"),
		filepath.Join(filepath.Dir(executable), "resources", "runtime"),
		filepath.Join(filepath.Dir(executable), "..", "Resources", "runtime"),
	}
	for _, candidate := range candidates {
		if _, err = os.Stat(filepath.Join(candidate, "dist", "server.js")); err == nil {
			return filepath.Clean(candidate), nil
		}
	}
	return "", errors.New("MemoryLane runtime not found; set MEMORYLANE_RUNTIME_DIR")
}

func bundledPluginsDir() string {
	return os.Getenv("MEMORYLANE_BUNDLED_PLUGIN_REPOSITORY")
}

func writeReadyMarker() {
	if marker := os.Getenv("MEMORYLANE_TRAY_READY_FILE"); marker != "" {
		_ = os.WriteFile(marker, []byte(strconv.FormatInt(time.Now().UnixMilli(), 10)), 0600)
	}
}

func nodeBinaryName() string { return platformNodeBinaryName() }

func validLocalURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.Hostname() == "127.0.0.1"
}
