package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// State remembers which files were already accepted by the server, keyed by
// absolute path. Size+mtime are kept so a re-saved file is re-uploaded, while a
// file the operator merely copied around is not.
type record struct {
	Size       int64     `json:"size"`
	ModifiedAt time.Time `json:"modifiedAt"`
	SHA256     string    `json:"sha256"`
	UploadedAt time.Time `json:"uploadedAt"`
	Result     string    `json:"result"`
}

type State struct {
	mu    sync.Mutex
	path  string
	Files map[string]record `json:"files"`
}

func LoadState(path string) *State {
	s := &State{path: path, Files: map[string]record{}}
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, s)
		if s.Files == nil {
			s.Files = map[string]record{}
		}
	}
	return s
}

func (s *State) Done(path string, size int64, mod time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.Files[path]
	return ok && r.Size == size && r.ModifiedAt.Equal(mod)
}

func (s *State) Mark(path string, size int64, mod time.Time, sha, result string) {
	s.mu.Lock()
	s.Files[path] = record{Size: size, ModifiedAt: mod, SHA256: sha, UploadedAt: time.Now(), Result: result}
	s.mu.Unlock()
	_ = s.save()
}

func (s *State) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.Files)
}

// save writes atomically — the lab PCs get powered off abruptly and a truncated
// state file would re-upload everything.
func (s *State) save() error {
	s.mu.Lock()
	raw, err := json.MarshalIndent(s, "", "  ")
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
