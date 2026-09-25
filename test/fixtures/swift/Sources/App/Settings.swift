struct Settings {
    var name = ""
    #if DEBUG
    var verbose = false
    #endif

    // Built under #if, around the members of a type: the grammar cannot parse
    // that, so the directives are blanked before parsing.
    var navigation: String {
        #if DEBUG
        return NavigationPanel(debug: true).title
        #else
        return NavigationPanel(debug: false).title
        #endif
    }
}

struct NavigationPanel {
    let debug: Bool
    var title: String { debug ? "debug" : "release" }
}

enum Recent {
    static let limit = 10
}
