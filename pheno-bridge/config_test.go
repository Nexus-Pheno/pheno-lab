package main

import (
	"testing"
	"time"
)

func testConfig(installedAt time.Time) *Config {
	cfg := defaultConfig()
	cfg.IngestFilesAfter = installedAt.Format(time.RFC3339)
	return &cfg
}

func TestSkipReason(t *testing.T) {
	now := time.Date(2026, 8, 26, 17, 0, 0, 0, time.UTC)
	installedAt := now.Add(-2 * time.Hour)
	cfg := testConfig(installedAt)

	settled := now.Add(-time.Minute) // written after install, no longer changing

	cases := []struct {
		name string
		file string
		size int64
		mod  time.Time
		want string
	}{
		{name: "a fresh measurement is uploaded", file: "E11-S5-1_Cindy.csv", size: 4060, mod: settled, want: ""},
		{name: "the screenshot beside it is uploaded", file: "E11-S5-1_Cindy.jpg", size: 112870, mod: settled, want: ""},
		{
			// The one that looks like a broken agent: Windows keeps the original
			// "date modified" when a file is copied, so a copied test file is
			// older than the install and is skipped on purpose.
			name: "a file copied in keeps its old timestamp and is skipped",
			file: "cell17-5-2_Chloe.csv",
			size: 4060,
			mod:  time.Date(2026, 4, 8, 11, 13, 12, 0, time.UTC),
			want: SkipTooOld,
		},
		{
			name: "a file still being written waits for the next scan",
			file: "E11-S6-1_Cindy.csv",
			size: 2000,
			mod:  now.Add(-time.Second),
			want: "still being written",
		},
		{name: "an unrelated file type is ignored", file: "notes.docx", size: 5000, mod: settled, want: "not a watched file type"},
		{name: "an empty file is ignored", file: "E11-S7.csv", size: 0, mod: settled, want: "empty"},
		{name: "an oversized file is ignored", file: "huge.csv", size: cfg.MaxFileBytes + 1, mod: settled, want: "larger than maxFileBytes"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cfg.skipReason(tc.file, tc.size, tc.mod, now)
			if got != tc.want {
				t.Errorf("skipReason(%q) = %q, want %q", tc.file, got, tc.want)
			}
		})
	}
}

// Re-saving a copied file is the documented way to get it picked up, so the
// same file must become eligible once its timestamp moves past the cutoff.
func TestResavingAnOldFileMakesItEligible(t *testing.T) {
	now := time.Date(2026, 8, 26, 17, 0, 0, 0, time.UTC)
	cfg := testConfig(now.Add(-2 * time.Hour))
	old := time.Date(2026, 4, 8, 11, 13, 12, 0, time.UTC)

	if got := cfg.skipReason("cell17-5-2.csv", 4060, old, now); got != SkipTooOld {
		t.Fatalf("expected the copied file to be skipped, got %q", got)
	}
	resaved := now.Add(-time.Minute)
	if got := cfg.skipReason("cell17-5-2.csv", 4060, resaved, now); got != "" {
		t.Errorf("expected the re-saved file to be eligible, got %q", got)
	}
}
