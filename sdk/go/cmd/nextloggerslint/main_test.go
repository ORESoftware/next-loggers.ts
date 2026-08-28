package main

import (
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckFileReportsUnsentEvents(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("testdata", "sample.go.txt"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "sample.go")
	if err := os.WriteFile(path, source, 0o600); err != nil {
		t.Fatal(err)
	}

	findings, err := checkFile(token.NewFileSet(), path, map[string]bool{defaultImportPath: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The fixture marks every expected report with a `// want: missing send` comment.
	var wantLines []int
	for index, line := range strings.Split(string(source), "\n") {
		if strings.Contains(line, "want: missing send") {
			wantLines = append(wantLines, index+1)
		}
	}
	if len(findings) != len(wantLines) {
		for _, item := range findings {
			t.Logf("%s: %s", item.position, item.message)
		}
		t.Fatalf("expected %d findings, got %d", len(wantLines), len(findings))
	}
	for index, want := range wantLines {
		if findings[index].position.Line != want {
			t.Fatalf("finding %d on line %d, want %d", index, findings[index].position.Line, want)
		}
	}
}

func TestFilesWithoutTheSdkImportAreIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "other.go")
	source := "package other\n\nfunc run(logger anyLogger) {\n\tlogger.Info(\"zap style\")\n}\n"
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	findings, err := checkFile(token.NewFileSet(), path, map[string]bool{defaultImportPath: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("expected no findings outside next-loggers files, got %d", len(findings))
	}
}
