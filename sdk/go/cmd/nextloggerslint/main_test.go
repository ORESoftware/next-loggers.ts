package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func TestLintFileIgnoresAssignedEvent(t *testing.T) {
	findings, err := lintFile("sample.go", []byte(`package sample
func f(logger Logger) {
	event := logger.Info("later")
	_ = event
}`), map[string]struct{}{"logger": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("expected no findings, got %#v", findings)
	}
}

func TestLintFileSupportsExplicitLoggerName(t *testing.T) {
	findings, err := lintFile("sample.go", []byte(`package sample
func f(audit Logger) {
	audit.Error("missing")
}`), map[string]struct{}{"audit": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 {
		t.Fatalf("expected one finding, got %d", len(findings))
	}
}

func TestCommandExitCodes(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "sample.go")
	if err := os.WriteFile(path, []byte(`package sample
func f(logger Logger) {
	logger.Info("missing")
}`), 0o600); err != nil {
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

func TestDocumentedTestdata(t *testing.T) {
	source, err := os.ReadFile("testdata/sample.go.txt")
	if err != nil {
		t.Fatal(err)
	}
	findings, err := lintFile("sample.go", source, map[string]struct{}{"logger": {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 {
		t.Fatalf("expected one finding, got %d", len(findings))
	}
}
