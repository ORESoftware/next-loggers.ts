package main

import (
	"bytes"
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

func TestLintFileReportsStandaloneUnsentChain(t *testing.T) {
	findings, err := lintFile("sample.go", []byte(`package sample
func f(logger Logger) {
	logger.Info("started").AddFields(nil)
}`), map[string]struct{}{"logger": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 {
		t.Fatalf("expected one finding, got %d", len(findings))
	}
	if findings[0].Line != 3 {
		t.Fatalf("expected line 3, got %d", findings[0].Line)
	}
}

func TestLintFileAcceptsTerminalSendMethods(t *testing.T) {
	findings, err := lintFile("sample.go", []byte(`package sample
func f(logger Logger) {
	logger.Info("sent").Send()
	logger.Warn("stored").SendWithStore()
}`), map[string]struct{}{"logger": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("expected no findings, got %#v", findings)
	}
}

func TestCommandExitCodes(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "sample.go")
	if err := os.WriteFile(path, []byte(`package sample

import nextloggers "github.com/ORESoftware/next-loggers.ts/sdk/go"

func f(logger *nextloggers.Logger) {
	logger.Info("missing")
}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{path}, &stdout, &stderr); code != 1 {
		t.Fatalf("expected exit 1, got %d: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "NL100") {
		t.Fatalf("expected NL100 output, got %q", stdout.String())
	}
}
