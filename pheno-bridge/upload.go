package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type uploadResponse struct {
	Status  string `json:"status"` // stored | duplicate | unmatched | rejected
	Message string `json:"message"`
	Scans   int    `json:"scans"`
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// upload posts one instrument file. The server owns all parsing: we send the
// bytes untouched plus the context only the lab PC knows (original path, the
// mtime, which rig it came from).
func (a *Agent) upload(path string, info os.FileInfo, sum string) (*uploadResponse, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	fields := map[string]string{
		"instrument":     a.cfg.Instrument,
		"instrumentName": a.cfg.InstrumentName,
		"sourcePath":     path,
		"sourceDir":      filepath.Dir(path),
		"fileName":       filepath.Base(path),
		"modifiedAt":     info.ModTime().Format(time.RFC3339),
		"sha256":         sum,
		"hostname":       a.hostname,
		"agentVersion":   version,
	}
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	part, err := w.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, f); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", a.cfg.ServerURL+"/api/ingest/jv", &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+a.cfg.APIKey)

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	var out uploadResponse
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode == 200 || resp.StatusCode == 201 || resp.StatusCode == 409:
		// 409 = the server already has this exact file; treat as done.
		if out.Status == "" {
			out.Status = "stored"
		}
		return &out, nil
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		// Go rewrites a redirected POST into a GET, so following one would look
		// successful while uploading nothing. Fail loudly instead.
		return nil, fmt.Errorf(
			"server redirected to %q — set serverUrl to that address (uploads must not be redirected)",
			resp.Header.Get("Location"),
		)
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, fmt.Errorf("server rejected our API key (%d) — re-run install with a fresh key", resp.StatusCode)
	case resp.StatusCode == 422:
		// The file is not something we can parse. Don't retry forever.
		if out.Status == "" {
			out.Status = "rejected"
		}
		return &out, nil
	default:
		return nil, fmt.Errorf("server returned %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
}

func (a *Agent) heartbeat(lastErr string) {
	payload, _ := json.Marshal(map[string]any{
		"instrument":     a.cfg.Instrument,
		"instrumentName": a.cfg.InstrumentName,
		"hostname":       a.hostname,
		"agentVersion":   version,
		"watchDirs":      a.cfg.WatchDirs,
		"filesKnown":     a.state.Count(),
		"uploadedTotal":  a.uploaded,
		"lastError":      lastErr,
	})
	req, err := http.NewRequest("POST", a.cfg.ServerURL+"/api/ingest/heartbeat", bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.cfg.APIKey)
	resp, err := a.client.Do(req)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	resp.Body.Close()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
