package store

import "fmt"

type Store struct {
	items map[string]int
}

var Default = New()

func New() *Store {
	return &Store{items: map[string]int{}}
}

func (s *Store) Put(key string, value int) {
	s.items[key] = s.normalise(value)
}

// Satisfies fmt.Stringer implicitly: nothing in this repo calls String().
func (s *Store) String() string {
	return fmt.Sprintf("%d items", len(s.items))
}

// Internal package, exported, never used: dead, since internal is not an API.
func (s *Store) Export() []string {
	return nil
}

func (s *Store) forgotten() int {
	return len(s.items)
}
