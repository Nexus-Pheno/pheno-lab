package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// DefaultServerURL is the production Pheno Lab deployment. The agents ship
// pointed at it so a lab install does not depend on someone remembering a host.
const DefaultServerURL = "https://lab.szkl.com"

// normalizeServerURL cleans up a hand-typed server address.
//
// Two real hazards it removes:
//   - the API key travels in an Authorization header, so plain HTTP to a public
//     host would leak it to anyone on the path;
//   - production answers HTTP with a 301, and Go rewrites a redirected POST into
//     a GET, so an "http://" typo would look fine yet upload nothing.
//
// Loopback and private addresses keep http:// — that is how the LAN trial and
// local development run.
func normalizeServerURL(raw string) (normalized string, upgraded bool, err error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false, fmt.Errorf("server URL is empty")
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false, fmt.Errorf("server URL is not a valid address: %w", err)
	}
	if parsed.Host == "" {
		return "", false, fmt.Errorf("server URL has no host")
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return "", false, fmt.Errorf("server URL must start with https:// (got %q)", parsed.Scheme)
	}

	if parsed.Scheme == "http" && !isLocalHost(parsed.Hostname()) {
		parsed.Scheme = "https"
		upgraded = true
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), upgraded, nil
}

// isLocalHost reports whether plain HTTP is acceptable for this host.
func isLocalHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}
