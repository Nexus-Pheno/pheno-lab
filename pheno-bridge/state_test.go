package main

import (
	"path/filepath"
	"testing"
	"time"
)

const lanServer = "http://10.40.26.61:3457"

func TestStateRemembersUploadsForTheSameServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	mod := time.Now().Truncate(time.Second)

	first := LoadState(path, lanServer)
	first.Mark("D:/data/scan.csv", 4060, mod, "abc", "stored")

	reopened := LoadState(path, lanServer)
	if !reopened.Done("D:/data/scan.csv", 4060, mod) {
		t.Fatal("a file uploaded to this server should not be uploaded again")
	}
}

// Moving a lab from the LAN trial to the cloud must re-send everything: those
// measurements exist only in the trial database, so treating them as "done"
// would silently keep them out of production forever.
func TestStateForgetsUploadsWhenTheServerChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	mod := time.Now().Truncate(time.Second)

	trial := LoadState(path, lanServer)
	trial.Mark("D:/data/scan.csv", 4060, mod, "abc", "stored")
	if trial.Count() != 1 {
		t.Fatalf("expected 1 recorded upload, got %d", trial.Count())
	}

	moved := LoadState(path, DefaultServerURL)
	if moved.Count() != 0 {
		t.Fatalf("expected the record to be forgotten, got %d", moved.Count())
	}
	if moved.Done("D:/data/scan.csv", 4060, mod) {
		t.Error("the file must be re-uploaded to the new server")
	}

	// And the new server's own record persists from then on.
	moved.Mark("D:/data/scan.csv", 4060, mod, "abc", "stored")
	again := LoadState(path, DefaultServerURL)
	if !again.Done("D:/data/scan.csv", 4060, mod) {
		t.Error("the new server's record should persist")
	}
}

func TestStateSurvivesAnUnreadableFile(t *testing.T) {
	dir := t.TempDir()
	state := LoadState(filepath.Join(dir, "does-not-exist.json"), DefaultServerURL)
	if state.Count() != 0 {
		t.Fatalf("a missing state file should start empty, got %d", state.Count())
	}
}
