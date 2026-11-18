import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// Theory of Magic: pins the web view to the safe area (notch, Dynamic Island,
/// home indicator) so the desktop-style game layout never sits under them,
/// fills the unsafe edges with the game's background colour, and hides the
/// status bar / home indicator for a fullscreen feel.
class MainViewController: CAPBridgeViewController {
    private static let gameBackground = UIColor(red: 0x1a / 255.0, green: 0x1a / 255.0, blue: 0x1a / 255.0, alpha: 1)

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let web = webView else { return }

        let root = UIView(frame: UIScreen.main.bounds)
        root.backgroundColor = MainViewController.gameBackground
        root.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(web)
        view = root

        let guide = root.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: guide.topAnchor),
            web.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: guide.trailingAnchor)
        ])

        web.isOpaque = false
        web.backgroundColor = MainViewController.gameBackground
        web.scrollView.backgroundColor = MainViewController.gameBackground
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
}
