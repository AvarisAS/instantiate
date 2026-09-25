import UIKit

final class Screen: UIViewController {
    // UIKit calls these; nothing in this repository does.
    override func viewDidLoad() {
        super.viewDidLoad()
        configure()
    }

    @IBAction func tapped(_ sender: Any) {}

    private func configure() {}

    private func leftover() {}
}
