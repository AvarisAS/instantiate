enum Formatter {
    static func shout(_ text: String) -> String {
        text.uppercased()
    }

    static func whisper(_ text: String) -> String {
        text.lowercased()
    }
}

func exportPDF() -> Data {
    fatalError("not implemented")
}
