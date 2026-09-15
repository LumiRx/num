# The ship pipeline — and the mechanism nobody had found
**15 Sep 2026**

## The thing that explains three builds of confusion

The Xcode project file has never matched what Apple holds. It read 5 when
Apple had 6. It read 7 when Apple had 8. Earlier notes put this down to
"something outside the repository" incrementing it.

Measured directly today:

```
the archive's Info.plist      CFBundleVersion 7
the IPA exported FROM it      CFBundleVersion 8
```

**`xcodebuild -exportArchive` silently increments the build number** when the
one you built is already taken at App Store Connect. There is no script, no
Xcode Cloud, nothing outside the repo. The export step does it — and it does it
*after* every check that reads the archive.

Three consequences, all of which were biting:

1. Auditing the archive is not auditing what ships. The pipeline now unzips the
   IPA and audits that too.
2. The build number to select in App Store Connect is the IPA's, not the
   project file's. Telling someone to "select build 7" would have sent them
   looking for a build that does not exist.
3. The project file drifts one behind after every collision, so the next build
   collides again. The pipeline now says what to set it to.

## What build 8 is

Build 8, uploaded 14 Sep 3:51 PM, **is the binary I built and verified.** Same
bits as the archive that passed every gate; only the number changed at export.

Audited again today, unpacked straight from the uploaded IPA:

```
bundle stamp 0.8.305 · version 1.0 (8) · store audit passed
```

Build 7 (13 Sep 7:55 PM) came from somewhere else and has not been checked.

## The pipeline

```
npm run app:ship
```

In this order, cheapest and most fallible first:

1. **Ask Apple what build numbers exist.** One request, one second. Refuses
   before the archive if the number would be rejected — Apple otherwise
   refuses it after the archive, the export and the transfer.
2. **Store check** — audit the bundle, then watch it launch and count page
   loads. One commit is normal; two is a reload.
3. **Archive.**
4. **Audit the archive.** The device archive and the simulator build are
   separate products of separate settings.
5. **Export, then audit the IPA.** Because of the renumbering above.
6. **Validate with Apple, then upload.**

`npm run app:ios` now runs the store check before it will open Xcode, so the
manual path is gated too.

### Credentials

Set these in your shell; the private key is never passed in or printed, only
read at run time from the standard `private_keys` folders altool already uses.

```
export ASC_KEY_ID=<the key id>
export ASC_ISSUER_ID=<the issuer uuid>
export ASC_APP_ID=6799727113
```

Without them the build-number preflight is skipped and says so.

## What the machine still cannot do

Two things, printed at the end of every successful ship:

1. **Install it from TestFlight and open it on a real phone.** Builds 5 and 6
   both went to App Review having never been opened by anyone. That is how both
   rejections happened.
2. **Select the build on the version page.** On 12 Sep the page was still
   pointing at the rejected build 2 at the moment of submission.

## Right now

- **1.0 is Rejected**, one open finding: 2.1.0.
- The version page still has **build 6** selected — the rejected binary.
- **Build 8 is the verified one.** Selecting it is the next action.
