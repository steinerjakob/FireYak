import UIKit
import Capacitor

// UIScene lifecycle, required for apps built with the iOS 27 SDK.
// The window and its CAPBridgeViewController come from Main.storyboard
// (UISceneStoryboardFile in Info.plist). This delegate only forwards
// launch, URL and universal-link events to Capacitor, which re-posts them
// for plugins (e.g. the App plugin's appUrlOpen).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
