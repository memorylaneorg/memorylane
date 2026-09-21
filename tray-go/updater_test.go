package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"runtime"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"0.2.0", "0.1.9", 1}, {"v1.0.0", "1.0.0", 0}, {"1.2.3", "1.3.0", -1},
	}
	for _, test := range cases {
		if got := compareVersions(test.left, test.right); got != test.want {
			t.Fatalf("compareVersions(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}
}

func TestVerifyManifest(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	updatePublicKey = base64.StdEncoding.EncodeToString(public)
	manifest := updateManifest{Version: "1.2.3", URL: "https://updates.example/MemoryLane.exe", SHA256: "0123456789abcdef"}
	message := manifest.Version + "\n" + manifest.URL + "\n" + manifest.SHA256
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
	if err = verifyManifest(manifest); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	manifest.URL += ".tampered"
	if err = verifyManifest(manifest); err == nil {
		t.Fatal("tampered manifest accepted")
	}
}

// Regression test for the "go run . reports Updates not configured" gap:
// pluginCatalogURL/updateFeedURL are only ever set via -X ldflags in a real
// packaged build (package-windows.ps1/package-macos.sh) - anyone running the
// tray straight from source (no ldflags) needs the same real hosted URL a
// packaged build for this host would have compiled in, not an empty string.
func TestHostReleasePlatform(t *testing.T) {
	got := hostReleasePlatform()
	want := map[string]string{"windows/amd64": "win32-x64", "darwin/arm64": "darwin-arm64"}[runtime.GOOS+"/"+runtime.GOARCH]
	if got != want {
		t.Fatalf("hostReleasePlatform() on %s/%s = %q, want %q", runtime.GOOS, runtime.GOARCH, got, want)
	}
}

func TestResolvedPluginCatalogURLFallsBackWhenUnset(t *testing.T) {
	original := pluginCatalogURL
	defer func() { pluginCatalogURL = original }()
	pluginCatalogURL = ""
	got := resolvedPluginCatalogURL()
	if platform := hostReleasePlatform(); platform != "" {
		want := "https://memorylaneapp.org/plugins/v1/stable/" + platform + "/catalog.json"
		if got != want {
			t.Fatalf("resolvedPluginCatalogURL() with no ldflag = %q, want %q", got, want)
		}
	} else if got != "" {
		t.Fatalf("resolvedPluginCatalogURL() on an unsupported host = %q, want empty", got)
	}
}
