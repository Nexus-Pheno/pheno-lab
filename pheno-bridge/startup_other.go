//go:build !windows

package main

import "fmt"

// Non-Windows builds exist so the agent can be developed and dry-run on a Mac;
// auto-start is a Windows-only concern.
func installStartup(exePath string) error {
	fmt.Printf("\n  (auto-start at logon is only wired up on Windows — start it by hand: %s run)\n", exePath)
	return nil
}

func removeStartup() error { return nil }
