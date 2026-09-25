import Foundation

final class Store {
    private var items: [String] = []
    let name: String

    init(name: String) {
        self.name = name
    }

    func add(_ item: String) {
        items.append(normalise(item))
    }

    func summary() -> String {
        "\(name): \(items.count)"
    }

    private func normalise(_ item: String) -> String {
        item.trimmingCharacters(in: .whitespaces)
    }

    // Nothing calls this.
    func purge() {
        items.removeAll()
    }
}

// Conforms to a protocol: CustomStringConvertible reads `description` itself.
extension Store: CustomStringConvertible {
    var description: String { summary() }

    func debugLabel() -> String {
        "Store(\(name))"
    }
}
