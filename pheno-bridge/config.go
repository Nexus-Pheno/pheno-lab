package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config is read from config.json next to the executable (falling back to
// %LOCALAPPDATA%\PhenoBridge\config.json).  Operators never edit this — it is
// written once at install time.
type Config struct {
	ServerURL      string   `json:"serverUrl"`
	APIKey         string   `json:"apiKey"`
	Instrument     string   `json:"instrument"`     // GIANTFORCE_IV | LIGHTSKY_LIV
	InstrumentName string   `json:"instrumentName"` // shown in the platform, e.g. 小太阳
	WatchDirs      []string `json:"watchDirs"`
	Extensions     []string `json:"extensions"`

	// Files older than this are ignored, so installing the agent never
	// back-fills years of history by accident. Set at first run if empty.
	IngestFilesAfter string `json:"ingestFilesAfter"`

	ScanIntervalSeconds int   `json:"scanIntervalSeconds"`
	StableSeconds       int   `json:"stableSeconds"`
	MaxFileBytes        int64 `json:"maxFileBytes"`
	HeartbeatSeconds    int   `json:"heartbeatSeconds"`

	path string
}

func defaultConfig() Config {
	return Config{
		Instrument:          "GIANTFORCE_IV",
		Extensions:          []string{".csv", ".xls", ".jpg", ".jpeg", ".png", ".txt"},
		ScanIntervalSeconds: 20,
		StableSeconds:       5,
		MaxFileBytes:        25 << 20,
		HeartbeatSeconds:    120,
	}
}

func configDir() string {
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		return filepath.Join(base, "PhenoBridge")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pheno-bridge")
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// findConfig prefers a config sitting beside the exe so a USB-stick copy is
// self-contained, then the per-user install location.
func findConfig() (string, error) {
	for _, p := range []string{
		filepath.Join(exeDir(), "config.json"),
		filepath.Join(configDir(), "config.json"),
	} {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no config.json found (looked in %s and %s) — run: pheno-bridge.exe install", exeDir(), configDir())
}

func LoadConfig() (*Config, error) {
	path, err := findConfig()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := defaultConfig()
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("config.json is not valid JSON: %w", err)
	}
	cfg.path = path

	// config.json is hand-edited when a lab moves from the LAN trial to the
	// cloud, so normalize rather than trust what was typed.
	normalized, upgraded, err := normalizeServerURL(cfg.ServerURL)
	if err != nil {
		return nil, fmt.Errorf("config.json: %w", err)
	}
	if upgraded {
		fmt.Printf("note: serverUrl %q was switched to https (the API key must not travel in clear text)\n", cfg.ServerURL)
	}
	cfg.ServerURL = normalized
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("config.json: apiKey is empty")
	}
	if len(cfg.WatchDirs) == 0 {
		return nil, fmt.Errorf("config.json: watchDirs is empty")
	}
	if cfg.IngestFilesAfter == "" {
		// First run: only take files written from now on.
		cfg.IngestFilesAfter = time.Now().Format(time.RFC3339)
		if err := cfg.Save(); err != nil {
			return nil, err
		}
	}
	return &cfg, nil
}

func (c *Config) Save() error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.path, append(raw, '\n'), 0o600)
}

func (c *Config) cutoff() time.Time {
	t, err := time.Parse(time.RFC3339, c.IngestFilesAfter)
	if err != nil {
		return time.Time{}
	}
	return t
}

// SkipTooOld is returned for files the age cutoff excludes. It is reported
// separately because it is the one skip reason that regularly surprises people:
// copying a file into the watched folder keeps its ORIGINAL modified time, so a
// copied test file looks older than the install and is ignored.
const SkipTooOld = "older than ingestFilesAfter"

// skipReason explains why a file is not eligible for upload, or "" if it is.
func (c *Config) skipReason(name string, size int64, mod, now time.Time) string {
	if !c.wants(name) {
		return "not a watched file type"
	}
	if size == 0 {
		return "empty"
	}
	if size > c.MaxFileBytes {
		return "larger than maxFileBytes"
	}
	if mod.Before(c.cutoff()) {
		return SkipTooOld
	}
	if mod.After(now.Add(-time.Duration(c.StableSeconds) * time.Second)) {
		return "still being written"
	}
	return ""
}

func (c *Config) wants(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	for _, e := range c.Extensions {
		if ext == strings.ToLower(e) {
			return true
		}
	}
	return false
}
