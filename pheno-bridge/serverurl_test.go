package main

import "testing"

func TestNormalizeServerURL(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		want     string
		upgraded bool
		wantErr  bool
	}{
		{name: "production host as typed", in: "https://lab.szkl.com", want: "https://lab.szkl.com"},
		{name: "trailing slash removed", in: "https://lab.szkl.com/", want: "https://lab.szkl.com"},
		{name: "surrounding spaces", in: "  https://lab.szkl.com  ", want: "https://lab.szkl.com"},
		{name: "bare host gets https", in: "lab.szkl.com", want: "https://lab.szkl.com"},
		{
			// Production answers http with a 301, and Go turns a redirected POST
			// into a GET — uploads would silently stop.
			name:     "public http is upgraded",
			in:       "http://lab.szkl.com",
			want:     "https://lab.szkl.com",
			upgraded: true,
		},
		{name: "loopback keeps http", in: "http://127.0.0.1:3457", want: "http://127.0.0.1:3457"},
		{name: "localhost keeps http", in: "http://localhost:3467", want: "http://localhost:3467"},
		{name: "LAN address keeps http", in: "http://10.40.26.61:3457", want: "http://10.40.26.61:3457"},
		{name: "private 192.168 keeps http", in: "http://192.168.11.210:3457", want: "http://192.168.11.210:3457"},
		{name: "subpath preserved", in: "https://lab.szkl.com/pheno/", want: "https://lab.szkl.com/pheno"},
		{name: "query and fragment dropped", in: "https://lab.szkl.com/?a=1#x", want: "https://lab.szkl.com"},
		{name: "empty is an error", in: "   ", wantErr: true},
		{name: "wrong scheme is an error", in: "ftp://lab.szkl.com", wantErr: true},
		{name: "no host is an error", in: "https://", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, upgraded, err := normalizeServerURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error for %q, got %q", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("normalizeServerURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if upgraded != tc.upgraded {
				t.Errorf("normalizeServerURL(%q) upgraded = %v, want %v", tc.in, upgraded, tc.upgraded)
			}
		})
	}
}

func TestDefaultServerURLIsProductionHTTPS(t *testing.T) {
	got, upgraded, err := normalizeServerURL(DefaultServerURL)
	if err != nil {
		t.Fatalf("the shipped default must be valid: %v", err)
	}
	if upgraded {
		t.Error("the shipped default must already be https")
	}
	if got != DefaultServerURL {
		t.Errorf("the shipped default must survive normalization: got %q", got)
	}
}
