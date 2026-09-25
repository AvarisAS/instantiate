import XCTest
@testable import App

final class StoreTests: XCTestCase {
    func testAdd() {
        let store = Store(name: "t")
        store.add("x")
        XCTAssertEqual(store.summary(), "t: 1")
    }
}
