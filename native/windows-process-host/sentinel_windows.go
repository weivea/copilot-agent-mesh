package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// The E2E harness copies the packaged image under this exact name so its
// no-tunnel trap is genuinely executable. No arguments are read or recorded.
func runSentinelIfRenamed() (int, bool) {
	executable, err := os.Executable()
	if err != nil || !strings.EqualFold(filepath.Base(executable), "mesh-e2e-sentinel.exe") {
		return 0, false
	}
	path := filepath.Join(filepath.Dir(executable), "devtunnel-invoked.json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		// Preserve the first invocation's evidence, never follow or overwrite a
		// pre-existing link. The harness requires a clean marker before each run.
		if os.IsExist(err) {
			if info, statErr := os.Lstat(path); statErr == nil && info.Mode().IsRegular() {
				return 97, true
			}
		}
		return 98, true
	}
	defer file.Close()
	evidence := struct {
		Invoked bool `json:"invoked"`
		PID     int  `json:"pid"`
	}{Invoked: true, PID: os.Getpid()}
	if json.NewEncoder(file).Encode(evidence) != nil || file.Sync() != nil {
		return 98, true
	}
	if file.Close() != nil {
		return 98, true
	}
	return 97, true
}
