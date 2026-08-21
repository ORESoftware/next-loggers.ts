// Command nextloggerslint reports next-loggers events that are constructed as
// standalone expressions but never terminated with Send or SendWithStore.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const missingSendMessage = "NL100 next-loggers event is only delivered when .Send() is called"

var levelMethods = map[string]struct{}{
	"Trace": {}, "Debug": {}, "Info": {}, "Log": {}, "Warn": {}, "Error": {}, "Fatal": {},
}

var terminalMethods = map[string]struct{}{"Send": {}, "SendWithStore": {}}
var skippedDirectories = map[string]struct{}{
	".git": {}, ".vendor": {}, ".zed": {}, "build": {}, "dist": {}, "node_modules": {}, "target": {}, "vendor": {},
}

type finding struct {
	Path    string
	Line    int
	Column  int
	Message string
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }
func (values *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("logger name must not be empty")
	}
	*values = append(*values, value)
	return nil
}

func qualifiedName(expression ast.Expr) (string, bool) {
	switch current := expression.(type) {
	case *ast.Ident:
		return current.Name, true
	case *ast.SelectorExpr:
		root, ok := qualifiedName(current.X)
		if !ok {
			return "", false
		}
		return root + "." + current.Sel.Name, true
	case *ast.ParenExpr:
		return qualifiedName(current.X)
	default:
		return "", false
	}
}

func callChain(expression ast.Expr, methods *[]string) (string, bool) {
	switch current := expression.(type) {
	case *ast.CallExpr:
		selector, ok := current.Fun.(*ast.SelectorExpr)
		if !ok {
			return qualifiedName(current.Fun)
		}
		root, rootOK := callChain(selector.X, methods)
		*methods = append(*methods, selector.Sel.Name)
		return root, rootOK
	case *ast.ParenExpr:
		return callChain(current.X, methods)
	default:
		return qualifiedName(expression)
	}
}

func lintFile(path string, source []byte, loggerNames map[string]struct{}) ([]finding, error) {
	files := token.NewFileSet()
	tree, err := parser.ParseFile(files, path, source, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	findings := make([]finding, 0)
	ast.Inspect(tree, func(node ast.Node) bool {
		statement, ok := node.(*ast.ExprStmt)
		if !ok {
			return true
		}
		methods := make([]string, 0, 4)
		root, ok := callChain(statement.X, &methods)
		if !ok {
			return true
		}
		if _, known := loggerNames[root]; !known {
			return true
		}
		levelIndex := -1
		for index, method := range methods {
			if _, level := levelMethods[method]; level {
				levelIndex = index
				break
			}
		}
		if levelIndex < 0 {
			return true
		}
		for _, method := range methods[levelIndex+1:] {
			if _, terminal := terminalMethods[method]; terminal {
				return true
			}
		}
		position := files.Position(statement.Pos())
		findings = append(findings, finding{
			Path: path, Line: position.Line, Column: position.Column, Message: missingSendMessage,
		})
		return true
	})
	return findings, nil
}

func collectFiles(arguments []string) ([]string, []error) {
	if len(arguments) == 0 {
		arguments = []string{"."}
	}
	files := make([]string, 0)
	errors := make([]error, 0)
	seen := make(map[string]struct{})

	var visit func(string)
	visit = func(path string) {
		metadata, err := os.Lstat(path)
		if err != nil {
			errors = append(errors, fmt.Errorf("%s: %w", path, err))
			return
		}
		if metadata.Mode()&os.ModeSymlink != 0 {
			return
		}
		if !metadata.IsDir() {
			if strings.HasSuffix(path, ".go") {
				clean := filepath.Clean(path)
				if _, exists := seen[clean]; !exists {
					seen[clean] = struct{}{}
					files = append(files, clean)
				}
			}
			return
		}
		walk := func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				errors = append(errors, fmt.Errorf("%s: %w", current, walkErr))
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() {
				if current != path {
					if _, skip := skippedDirectories[entry.Name()]; skip {
						return filepath.SkipDir
					}
				}
				return nil
			}
			if strings.HasSuffix(entry.Name(), ".go") {
				clean := filepath.Clean(current)
				if _, exists := seen[clean]; !exists {
					seen[clean] = struct{}{}
					files = append(files, clean)
				}
			}
			return nil
		}
		if err := filepath.WalkDir(path, walk); err != nil {
			errors = append(errors, fmt.Errorf("%s: %w", path, err))
		}
	}

	for _, argument := range arguments {
		path := strings.TrimSuffix(argument, string(filepath.Separator)+"...")
		if argument == "..." || path == "" {
			path = "."
		}
		visit(filepath.Clean(path))
	}
	sort.Strings(files)
	return files, errors
}

func run(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("nextloggerslint", flag.ContinueOnError)
	flags.SetOutput(stderr)
	extraLoggerNames := stringList{}
	flags.Var(&extraLoggerNames, "logger-name", "extra variable or property path holding a next-loggers logger; repeatable")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	loggerNames := map[string]struct{}{"log": {}, "logger": {}, "ddlog": {}}
	for _, name := range extraLoggerNames {
		loggerNames[name] = struct{}{}
	}
	files, collectionErrors := collectFiles(flags.Args())
	for _, err := range collectionErrors {
		fmt.Fprintln(stderr, err)
	}
	findingCount := 0
	for _, path := range files {
		source, err := os.ReadFile(path)
		if err != nil {
			collectionErrors = append(collectionErrors, fmt.Errorf("%s: %w", path, err))
			fmt.Fprintln(stderr, collectionErrors[len(collectionErrors)-1])
			continue
		}
		findings, err := lintFile(path, source, loggerNames)
		if err != nil {
			collectionErrors = append(collectionErrors, fmt.Errorf("%s: %w", path, err))
			fmt.Fprintln(stderr, collectionErrors[len(collectionErrors)-1])
			continue
		}
		for _, item := range findings {
			findingCount++
			fmt.Fprintf(stdout, "%s:%d:%d: %s\n", item.Path, item.Line, item.Column, item.Message)
		}
	}
	if len(collectionErrors) > 0 {
		return 2
	}
	if findingCount > 0 {
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
