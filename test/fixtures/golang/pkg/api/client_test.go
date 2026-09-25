package api

import "testing"

func TestGet(t *testing.T) {
	if NewClient().Get("/x") != "/x" {
		t.Fatal("wrong")
	}
}
