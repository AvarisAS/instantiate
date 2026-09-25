package main

import (
	"fmt"

	_ "example.com/app/internal/plugins"
	"example.com/app/internal/store"
)

func main() {
	s := store.New()
	s.Put("a", 1)
	fmt.Println(s)
	fmt.Println(helper())
}

func helper() string {
	return describe(store.Default)
}
