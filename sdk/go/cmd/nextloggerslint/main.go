// Command nextloggerslint reports next-loggers events that are built but never
// sent, the Go counterpart of the `next-loggers/require-send` ESLint rule.
//
//	go run github.com/ORESoftware/next-loggers.ts/sdk/go/cmd/nextloggerslint@latest ./...
//
// A statement such as
//
//	logger.Info("started").AddFields(fields)
//
// creates an event that is registered as unsent and only reaches transports on
// Send(), so it is reported. Chains ending in Send()/SendWithStore(), and
// events assigned to a variable (which the linter cannot follow), are ignored.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const defaultImportPath = "github.com/ORESoftware/next-loggers.ts/sdk/go"

var levelMethods = map[string]bool{
	"Trace": true,
	"Debug": true,
	"Info":  true,
	"Log":   true,
	"Warn":  true,
	"Error": true,
	"Fatal": true,
}

var sendMethods = map[string]bool{
	"Send":          true,
	"SendWithStore": true,
}

type finding struct {
	position token.Position
	message  string
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	for _, item := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			*values = append(*values, trimmed)
		}
	}
	return nil
}

func main() {
	var extraLoggers stringList
	var extraImports stringList
	flag.Var(&extraLoggers, "logger", "extra variable names holding a logger (comma separated)")
	flag.Var(&extraImports, "import", "extra next-loggers import paths (comma separated)")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: nextloggerslint [flags] [packages or files]\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	targets := flag.Args()
	if len(targets) == 0 {
		targets = []string{"./..."}
	}
	imports := map[string]bool{defaultImportPath: true}
	for _, value := range extraImports {
		imports[value] = true
	}

	files, err := collect(targets)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nextloggerslint: %v\n", err)
		os.Exit(2)
	}

	fileSet := token.NewFileSet()
	var findings []finding
	for _, path := range files {
		found, err := checkFile(fileSet, path, imports, extraLoggers)
		if err != nil {
			fmt.Fprintf(os.Stderr, "nextloggerslint: %v\n", err)
			os.Exit(2)
		}
		findings = append(findings, found...)
	}

	sort.Slice(findings, func(first, second int) bool {
		if findings[first].position.Filename != findings[second].position.Filename {
			return findings[first].position.Filename < findings[second].position.Filename
		}
		return findings[first].position.Offset < findings[second].position.Offset
	})
	for _, item := range findings {
		fmt.Printf("%s: %s\n", item.position, item.message)
	}
	if len(findings) > 0 {
		os.Exit(1)
	}
}

// collect expands ./... style targets, directories, and explicit .go files.
func collect(targets []string) ([]string, error) {
	var files []string
	seen := map[string]bool{}
	add := func(path string) {
		if strings.HasSuffix(path, ".go") && !seen[path] {
			seen[path] = true
			files = append(files, path)
		}
	}
	for _, target := range targets {
		recursive := strings.HasSuffix(target, "...")
		root := strings.TrimSuffix(strings.TrimSuffix(target, "..."), string(os.PathSeparator))
		if root == "" {
			root = "."
		}
		info, err := os.Stat(root)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			add(root)
			continue
		}
		if !recursive {
			entries, err := os.ReadDir(root)
			if err != nil {
				return nil, err
			}
			for _, entry := range entries {
				if !entry.IsDir() {
					add(filepath.Join(root, entry.Name()))
				}
			}
			continue
		}
		walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				name := entry.Name()
				if path != root && (name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			add(path)
			return nil
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}
	sort.Strings(files)
	return files, nil
}

func checkFile(
	fileSet *token.FileSet,
	path string,
	imports map[string]bool,
	extraLoggers []string,
) ([]finding, error) {
	file, err := parser.ParseFile(fileSet, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}

	packageAliases := map[string]bool{}
	for _, spec := range file.Imports {
		value, err := strconv.Unquote(spec.Path.Value)
		if err != nil || !imports[value] {
			continue
		}
		if spec.Name != nil {
			packageAliases[spec.Name.Name] = true
			continue
		}
		packageAliases[filepath.Base(value)] = true
		// The Go SDK's package name differs from its final path element.
		packageAliases["nextloggers"] = true
	}

	loggers := map[string]bool{}
	for _, name := range extraLoggers {
		loggers[name] = true
	}
	// Only files that import the SDK are inspected, so bare names such as
	// `logger` cannot collide with an unrelated logging library.
	if len(packageAliases) == 0 {
		return nil, nil
	}
	for _, name := range []string{"log", "logger", "ddlog"} {
		loggers[name] = true
	}
	collectLoggerNames(file, packageAliases, loggers)

	var findings []finding
	ast.Inspect(file, func(node ast.Node) bool {
		statement, ok := node.(*ast.ExprStmt)
		if !ok {
			return true
		}
		var methods []string
		root := callChain(statement.X, &methods)
		if root == "" || !isLoggerRoot(root, loggers) {
			return true
		}
		levelIndex := -1
		for index, method := range methods {
			if levelMethods[method] {
				levelIndex = index
				break
			}
		}
		if levelIndex < 0 {
			return true
		}
		for _, method := range methods[levelIndex+1:] {
			if sendMethods[method] {
				return true
			}
		}
		findings = append(findings, finding{
			position: fileSet.Position(statement.Pos()),
			message:  "next-loggers event is never sent; call .Send() so it reaches transports",
		})
		return true
	})
	return findings, nil
}

// isLoggerRoot matches both `logger.Info(...)` and `service.logger.Info(...)`,
// where only the field name is known to be a logger.
func isLoggerRoot(root string, loggers map[string]bool) bool {
	if loggers[root] {
		return true
	}
	if index := strings.LastIndex(root, "."); index >= 0 {
		return loggers[root[index+1:]]
	}
	return false
}

// collectLoggerNames records variables assigned from NewLogger or declared as a
// *nextloggers.Logger, plus fields of that type.
func collectLoggerNames(file *ast.File, packageAliases map[string]bool, loggers map[string]bool) {
	isLoggerType := func(expr ast.Expr) bool {
		if star, ok := expr.(*ast.StarExpr); ok {
			expr = star.X
		}
		selector, ok := expr.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "Logger" {
			return false
		}
		identifier, ok := selector.X.(*ast.Ident)
		return ok && packageAliases[identifier.Name]
	}
	isLoggerCall := func(expr ast.Expr) bool {
		call, ok := expr.(*ast.CallExpr)
		if !ok {
			return false
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "NewLogger" {
			return false
		}
		identifier, ok := selector.X.(*ast.Ident)
		return ok && packageAliases[identifier.Name]
	}

	ast.Inspect(file, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.AssignStmt:
			for index, target := range typed.Lhs {
				identifier, ok := target.(*ast.Ident)
				if !ok || index >= len(typed.Rhs) {
					continue
				}
				if isLoggerCall(typed.Rhs[index]) {
					loggers[identifier.Name] = true
				}
			}
		case *ast.ValueSpec:
			for _, name := range typed.Names {
				if typed.Type != nil && isLoggerType(typed.Type) {
					loggers[name.Name] = true
					continue
				}
				for _, value := range typed.Values {
					if isLoggerCall(value) {
						loggers[name.Name] = true
					}
				}
			}
		case *ast.Field:
			if typed.Type != nil && isLoggerType(typed.Type) {
				for _, name := range typed.Names {
					loggers[name.Name] = true
				}
			}
		}
		return true
	})
}

// callChain returns the root identifier of a selector call chain and appends
// each called method, outermost last.
func callChain(expr ast.Expr, methods *[]string) string {
	switch typed := expr.(type) {
	case *ast.CallExpr:
		selector, ok := typed.Fun.(*ast.SelectorExpr)
		if !ok {
			return rootName(typed.Fun)
		}
		root := callChain(selector.X, methods)
		*methods = append(*methods, selector.Sel.Name)
		return root
	default:
		return rootName(expr)
	}
}

func rootName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		root := rootName(typed.X)
		if root == "" {
			return ""
		}
		return root + "." + typed.Sel.Name
	case *ast.ParenExpr:
		return rootName(typed.X)
	}
	return ""
}
