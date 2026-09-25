package plugins

var registry = map[string]func() string{}

// Runs because main imports this package for its side effects.
func init() {
	registry["csv"] = exportCSV
}

func exportCSV() string {
	return "csv"
}

func notImplemented() string {
	panic("not implemented")
}
