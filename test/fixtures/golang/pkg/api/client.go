package api

// A public package: its exported names are a contract with other modules.
type Client struct{}

func (c *Client) Get(path string) string {
	return path
}

func NewClient() *Client {
	return &Client{}
}

// Unexported and unused: dead even in a public package.
func retry() {}
