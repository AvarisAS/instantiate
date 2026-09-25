@main
struct App {
    static func main() {
        let store = Store(name: "notes")
        store.add("hello")
        print(Formatter.shout(store.summary()))
    }
}
