// pheno-bridge — the uploader that runs on the two JV simulator PCs.
//
// It watches the folder the instrument software writes into, waits for each new
// file to stop growing, and POSTs it untouched to the Pheno Lab server. All
// parsing happens server-side, so a parser fix is a web deploy and never a trip
// to the lab. Requires no administrator rights: it installs into %LOCALAPPDATA%
// and starts itself from the per-user Startup folder.
//
//	pheno-bridge.exe install     configure + install + auto-start at logon
//	pheno-bridge.exe run         run in the foreground (what Startup launches)
//	pheno-bridge.exe test        check the server connection and exit
//	pheno-bridge.exe status      print what has been uploaded
//	pheno-bridge.exe uninstall   remove the auto-start entry
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const version = "0.1.0"

type Agent struct {
	cfg      *Config
	state    *State
	client   *http.Client
	hostname string
	uploaded int
}

func main() {
	cmd := "run"
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		cmd = os.Args[1]
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}

	var err error
	switch cmd {
	case "install":
		err = cmdInstall()
	case "uninstall":
		err = cmdUninstall()
	case "test":
		err = cmdTest()
	case "status":
		err = cmdStatus()
	case "run":
		err = cmdRun()
	default:
		fmt.Printf("pheno-bridge %s\nusage: pheno-bridge.exe [install|run|test|status|uninstall]\n", version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\nERROR: %v\n", err)
		if cmd == "install" || cmd == "test" {
			fmt.Fprintln(os.Stderr, "\nPress Enter to close.")
			_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

func newAgent(cfg *Config) *Agent {
	host, _ := os.Hostname()
	return &Agent{
		cfg:      cfg,
		state:    LoadState(filepath.Join(configDir(), "state.json")),
		client:   &http.Client{Timeout: 120 * time.Second},
		hostname: host,
	}
}

func cmdRun() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	closeLog := setupLogging()
	defer closeLog()

	a := newAgent(cfg)
	log.Printf("pheno-bridge %s starting — instrument=%s host=%s server=%s", version, cfg.Instrument, a.hostname, cfg.ServerURL)
	log.Printf("watching %s (files modified after %s)", strings.Join(cfg.WatchDirs, "; "), cfg.IngestFilesAfter)

	scanEvery := time.Duration(cfg.ScanIntervalSeconds) * time.Second
	beatEvery := time.Duration(cfg.HeartbeatSeconds) * time.Second
	lastBeat := time.Time{}
	lastErr := ""
	backoff := scanEvery

	for {
		n, err := a.scanOnce()
		if err != nil {
			lastErr = err.Error()
			log.Printf("scan: %v (retrying in %s)", err, backoff)
			if backoff < 10*time.Minute {
				backoff *= 2
			}
		} else {
			if n > 0 {
				log.Printf("uploaded %d file(s); %d known in total", n, a.state.Count())
			}
			lastErr = ""
			backoff = scanEvery
		}
		if time.Since(lastBeat) >= beatEvery {
			a.heartbeat(lastErr)
			lastBeat = time.Now()
		}
		time.Sleep(backoff)
	}
}

// scanOnce walks the watched folders once and uploads everything new. A file is
// only considered once it has stopped changing, so we never grab a CSV the
// instrument software is still writing.
func (a *Agent) scanOnce() (int, error) {
	type candidate struct {
		path string
		info os.FileInfo
	}
	var found []candidate
	cutoff := a.cfg.cutoff()
	stableBefore := time.Now().Add(-time.Duration(a.cfg.StableSeconds) * time.Second)

	for _, dir := range a.cfg.WatchDirs {
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				// An unreadable subfolder must not stop the whole scan.
				log.Printf("skip %s: %v", path, err)
				if info != nil && info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if info.IsDir() {
				return nil
			}
			if !a.cfg.wants(info.Name()) || info.Size() == 0 {
				return nil
			}
			if info.Size() > a.cfg.MaxFileBytes {
				return nil
			}
			mod := info.ModTime()
			if mod.Before(cutoff) || mod.After(stableBefore) {
				return nil
			}
			if a.state.Done(path, info.Size(), mod) {
				return nil
			}
			found = append(found, candidate{path, info})
			return nil
		})
		if err != nil {
			return 0, fmt.Errorf("walking %s: %w", dir, err)
		}
	}

	sort.Slice(found, func(i, j int) bool { return found[i].info.ModTime().Before(found[j].info.ModTime()) })

	sent := 0
	for _, c := range found {
		sum, err := hashFile(c.path)
		if err != nil {
			log.Printf("skip %s: %v", c.path, err)
			continue
		}
		res, err := a.upload(c.path, c.info, sum)
		if err != nil {
			// Network or server problem: stop here and retry the whole batch
			// next cycle, preserving order.
			return sent, err
		}
		a.state.Mark(c.path, c.info.Size(), c.info.ModTime(), sum, res.Status)
		a.uploaded++
		sent++
		msg := fmt.Sprintf("%s → %s", filepath.Base(c.path), res.Status)
		if res.Scans > 0 {
			msg += fmt.Sprintf(" (%d scan(s))", res.Scans)
		}
		if res.Message != "" {
			msg += ": " + res.Message
		}
		log.Print(msg)
	}
	return sent, nil
}

func cmdTest() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	a := newAgent(cfg)
	fmt.Printf("pheno-bridge %s\n  server:     %s\n  instrument: %s (%s)\n  host:       %s\n",
		version, cfg.ServerURL, cfg.InstrumentName, cfg.Instrument, a.hostname)
	for _, d := range cfg.WatchDirs {
		if st, err := os.Stat(d); err != nil {
			fmt.Printf("  watch:      %s  ✗ %v\n", d, err)
		} else if !st.IsDir() {
			fmt.Printf("  watch:      %s  ✗ not a folder\n", d)
		} else {
			fmt.Printf("  watch:      %s  ✓\n", d)
		}
	}
	req, _ := http.NewRequest("GET", cfg.ServerURL+"/api/ingest/heartbeat", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the server: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != 200 {
		return fmt.Errorf("server said %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
	fmt.Printf("  connection: ✓ %s\n", truncate(strings.TrimSpace(string(raw)), 200))
	fmt.Println("\nAll good. Press Enter to close.")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	return nil
}

func cmdStatus() error {
	st := LoadState(filepath.Join(configDir(), "state.json"))
	fmt.Printf("pheno-bridge %s — %d file(s) recorded\n", version, st.Count())
	type row struct {
		path string
		rec  record
	}
	var rows []row
	for p, r := range st.Files {
		rows = append(rows, row{p, r})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].rec.UploadedAt.After(rows[j].rec.UploadedAt) })
	for i, r := range rows {
		if i >= 20 {
			break
		}
		fmt.Printf("  %s  %-10s %s\n", r.rec.UploadedAt.Format("2006-01-02 15:04"), r.rec.Result, filepath.Base(r.path))
	}
	return nil
}

func setupLogging() func() {
	dir := filepath.Join(configDir(), "logs")
	_ = os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, "bridge.log")
	// Cheap rotation: the lab PCs have small disks and nobody prunes logs.
	if st, err := os.Stat(path); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.SetFlags(log.LstdFlags)
		return func() {}
	}
	log.SetFlags(log.LstdFlags)
	log.SetOutput(io.MultiWriter(os.Stdout, f))
	return func() { _ = f.Close() }
}

func cmdInstall() error {
	var (
		server  = flag.String("server", "", "Pheno Lab server URL, e.g. https://lab.szpheno.com")
		key     = flag.String("key", "", "instrument API key issued by the platform")
		instr   = flag.String("instrument", "", "GIANTFORCE_IV (小太阳) or LIGHTSKY_LIV (大太阳)")
		name    = flag.String("name", "", "display name for this rig")
		watch   = flag.String("watch", "", "folder to watch (repeat with ; between folders)")
		history = flag.Bool("include-history", false, "also upload files that already exist (default: only new ones)")
	)
	flag.Parse()

	in := bufio.NewReader(os.Stdin)
	ask := func(label, cur, fallback string) string {
		if cur != "" {
			return cur
		}
		if fallback != "" {
			fmt.Printf("%s [%s]: ", label, fallback)
		} else {
			fmt.Printf("%s: ", label)
		}
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return fallback
		}
		return line
	}

	fmt.Printf("pheno-bridge %s — setup\n\n", version)
	cfg := defaultConfig()
	cfg.ServerURL = strings.TrimRight(ask("Server URL", *server, ""), "/")
	cfg.APIKey = ask("Instrument API key", *key, "")
	cfg.Instrument = strings.ToUpper(ask("Instrument (1 = GiantForce 小太阳, 2 = LIGHTSKY 大太阳)", *instr, "1"))
	switch cfg.Instrument {
	case "1", "GIANTFORCE_IV":
		cfg.Instrument = "GIANTFORCE_IV"
		cfg.InstrumentName = ask("Display name", *name, "小太阳 (GiantForce)")
		cfg.WatchDirs = splitDirs(ask("Folder to watch", *watch, `D:\IV Measurement System\Data`))
	case "2", "LIGHTSKY_LIV":
		cfg.Instrument = "LIGHTSKY_LIV"
		cfg.InstrumentName = ask("Display name", *name, "大太阳 (LIGHTSKY LSS-200)")
		cfg.WatchDirs = splitDirs(ask("Folder to watch", *watch, `D:\PhenoUpload`))
	default:
		return fmt.Errorf("unknown instrument %q", cfg.Instrument)
	}
	if cfg.ServerURL == "" || cfg.APIKey == "" {
		return fmt.Errorf("server URL and API key are both required")
	}
	if *history {
		cfg.IngestFilesAfter = time.Unix(0, 0).UTC().Format(time.RFC3339)
	} else {
		cfg.IngestFilesAfter = time.Now().Format(time.RFC3339)
	}

	dir := configDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, d := range cfg.WatchDirs {
		if st, err := os.Stat(d); err != nil || !st.IsDir() {
			fmt.Printf("\n  ! %s does not exist yet — create it before the next test run.\n", d)
		}
	}

	// Copy ourselves next to the config so the USB stick can go away.
	target := filepath.Join(dir, "pheno-bridge.exe")
	if err := copySelf(target); err != nil {
		return fmt.Errorf("copying the program into %s: %w", dir, err)
	}
	cfg.path = filepath.Join(dir, "config.json")
	if err := cfg.Save(); err != nil {
		return err
	}
	if err := installStartup(target); err != nil {
		return err
	}

	fmt.Printf("\nInstalled.\n  program: %s\n  config:  %s\n  logs:    %s\n  starts:  automatically at logon\n",
		target, cfg.path, filepath.Join(dir, "logs", "bridge.log"))
	fmt.Println("\nNow run:  pheno-bridge.exe test")
	fmt.Println("\nPress Enter to close.")
	_, _ = in.ReadString('\n')
	return nil
}

func splitDirs(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ";") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, filepath.Clean(p))
		}
	}
	return out
}

func copySelf(target string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if sameFile(self, target) {
		return nil
	}
	src, err := os.Open(self)
	if err != nil {
		return err
	}
	defer src.Close()
	// A running copy cannot be overwritten on Windows; move it aside first.
	if _, err := os.Stat(target); err == nil {
		_ = os.Remove(target + ".old")
		_ = os.Rename(target, target+".old")
	}
	dst, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}

func sameFile(a, b string) bool {
	ai, err1 := os.Stat(a)
	bi, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(ai, bi)
}

func cmdUninstall() error {
	if err := removeStartup(); err != nil {
		return err
	}
	fmt.Println("Auto-start removed. The program and its config are still in", configDir())
	return nil
}
