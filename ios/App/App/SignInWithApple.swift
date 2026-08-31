//  Sign in with Apple — a hand-written Capacitor plugin.
//
//  WHY HAND-WRITTEN, NOT A COMMUNITY PLUGIN
//
//  Adding an npm dependency here would mean `npm install` inside
//  ~/num-worktrees/app-main, and that working tree is shared with the Mac's
//  deploy shell — installing into it has broken deploys before, so the repo
//  rule is simply "don't". This file needs no dependency: ASAuthorization is
//  in AuthenticationServices, which ships with iOS.
//
//  WHY IT EXISTS AT ALL
//
//  App Review rejected 1.0(2) under guideline 4.8: the app offered "Continue
//  with Google" and no login service that limits collection to name and email,
//  lets the user hide their email, and does not track for ads. Sign in with
//  Apple is Apple's own named example of one that does.
//
//  WHAT IT DOES *NOT* DO
//
//  It does not decide anything. It hands the raw identityToken (a JWT signed
//  by Apple) to the web layer, which posts it to /api/social/apple, and the
//  Worker verifies the signature against Apple's public keys before trusting a
//  single field. A client that could assert its own identity would be an
//  account takeover with extra steps — the same lesson as SEC-001.
import Foundation
import AuthenticationServices
import Capacitor

@objc(SignInWithApplePlugin)
public class SignInWithApplePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SignInWithApplePlugin"
    public let jsName = "SignInWithApple"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        // Held so the delegate callbacks can resolve it. Capacitor releases a
        // call as soon as this method returns unless it is retained.
        call.keepAlive = true
        self.pendingCall = call

        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            // Name and email ONLY. Guideline 4.8 requires the equivalent login
            // to limit collection to exactly these, so asking for more would
            // defeat the reason this exists.
            request.requestedScopes = [.fullName, .email]

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func finish(_ resolve: Bool, _ payload: [String: Any], _ message: String = "") {
        guard let call = pendingCall else { return }
        pendingCall = nil
        call.keepAlive = false
        if resolve { call.resolve(payload) } else { call.reject(message) }
    }
}

extension SignInWithApplePlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            finish(false, [:], "Apple did not return an identity token.")
            return
        }

        // APPLE SENDS THE NAME EXACTLY ONCE — on the very first authorization
        // for this Apple ID, and never again, not even after deleting the app.
        // So it is forwarded now and stored server-side on first sight; asking
        // for it later is not possible, and a second sign-in legitimately
        // carries no name at all.
        var payload: [String: Any] = ["identityToken": token, "user": cred.user]
        if let given = cred.fullName?.givenName, !given.isEmpty {
            let family = cred.fullName?.familyName ?? ""
            payload["name"] = family.isEmpty ? given : "\(given) \(family)"
        }
        if let email = cred.email, !email.isEmpty { payload["email"] = email }
        if let code = cred.authorizationCode, let s = String(data: code, encoding: .utf8) {
            payload["authorizationCode"] = s
        }
        finish(true, payload)
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        // A cancel is not a failure worth shouting about — the caller shows
        // nothing rather than an error the user caused on purpose.
        let code = (error as? ASAuthorizationError)?.code
        finish(false, [:], code == .canceled ? "cancelled" : error.localizedDescription)
    }
}

extension SignInWithApplePlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // THE iPad LESSON, APPLIED. 1.0(2) crashed in review because a picker
        // was presented with no anchor. UIKit needs a real window here too, so
        // the plugin's own bridge window is used rather than assuming one.
        return self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
