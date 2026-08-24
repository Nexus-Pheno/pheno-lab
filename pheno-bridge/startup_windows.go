//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// The lab accounts are not administrators, so we auto-start from the per-user
// Startup folder rather than installing a service. The agent therefore runs
// whenever someone is logged in — which is exactly when the instrument software
// is usable anyway.
func startupScriptPath() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", fmt.Errorf("APPDATA is not set")
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "PhenoBridge.cmd"), nil
}

func installStartup(exePath string) error {
	path, err := startupScriptPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	script := "@echo off\r\n" +
		"rem Pheno Lab instrument uploader - starts minimised at logon\r\n" +
		fmt.Sprintf("start \"Pheno Bridge\" /min \"%s\" run\r\n", exePath)
	return os.WriteFile(path, []byte(script), 0o644)
}

func removeStartup() error {
	path, err := startupScriptPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
