package main

import "example.com/app/internal/store"

// Reached from main.go by bare name: same package, different file.
func describe(s *store.Store) string {
	return s.Name()
}

// Nothing calls this.
func unusedInMain() int {
	return 42
}
