package store

// A method in a different file from its type.
func (s *Store) Name() string {
	return "store"
}

func (s *Store) normalise(v int) int {
	return v * 2
}

// Required by an interface in this repo, so it may be called through it.
func (s *Store) flush() error {
	return nil
}

type flusher interface {
	flush() error
}

var _ flusher = (*Store)(nil)
