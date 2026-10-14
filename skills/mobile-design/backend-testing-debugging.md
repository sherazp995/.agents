# Backend, Testing and Debugging for Mobile

## Mobile API

Mobile clients have unreliable networks, limited battery and storage, interrupted sessions, old devices, and slow binary updates (store review). Defaults the model reaches for, and the mobile fix:

| Default | Mobile-correct |
|---------|----------------|
| Same API and full objects for web and mobile | Field selection (`?fields=id,name,thumbnail`) or mobile endpoints, pagination |
| No offline consideration | Offline-first design, sync queue |
| WebSocket for everything | Push notifications + polling fallback (battery) |
| No app versioning | Version headers, minimum version check |
| Generic errors | Error codes with a user message and a recovery action |
| Session auth | Tokens with refresh (apps restart) |
| No device info | App version, platform, device ID headers |

- Pagination: cursor-based (`?limit=20&after=cursor`), not offset; offsets duplicate items when data changes and slow down at depth.
- Batch several GETs into one request (one round trip, radio wakes once). Delta sync returns only records changed since a timestamp.
- Images: request variants (`/images/{id}?w=400&h=300&q=80&format=webp`) from a CDN with long `Cache-Control`.
- Large uploads: chunked and resumable (init, PUT 1 to 5MB chunks, complete).
- Streaming: HLS for iOS, HLS or DASH for Android, adaptive bitrate, range requests.

Every request sends `X-App-Version`, `X-Platform`, `X-OS-Version`, `X-Device-Model`, `X-Device-ID`, `X-Request-ID`, `Accept-Language`, `X-Timezone`. Alert on error rate over 5% per version, P95 over 2s, crash spikes per version, auth and push failure spikes.

### Versioning

`GET /api/app-config` returns `minimum_version`, `latest_version`, `force_update`, `update_url`, `feature_flags`, `maintenance`. Below minimum: block with a force update screen. Below latest: optional prompt. Feature flags allow gradual rollout without a release.

### Errors

```json
{ "error": { "code": "PAYMENT_DECLINED", "user_message": "Check your card or try another method",
  "action": { "type": "navigate", "destination": "payment_methods" },
  "retry": { "allowed": true, "after_seconds": 5 } } }
```

401: silent refresh, then retry once; refresh failure logs out. 404: drop from local cache. 409: sync conflict UI. 429: honor `Retry-After`. 5xx: backoff. No network: cached data and queue.

### Auth tokens

Access token short-lived (15 min to 1 hour) and in memory. Refresh token 30 to 90 days in Keychain/SecureStore, rotated on each use. A device token lets the server list devices and "log out all devices". Never store tokens in AsyncStorage, persisted Redux state or logs.

### Security

- Device attestation: iOS DeviceCheck / App Attest, Android Play Integrity (SafetyNet is retired), verified server-side, fail closed.
- Request signing: HMAC over timestamp + path + body, reject timestamps older than 5 minutes.
- Rate limit per device, per user and per endpoint, with `X-RateLimit-*` and `Retry-After`.

## Push notifications

FCM for Android; APNs for iOS directly or through FCM (FCM still delivers via APNs, which must be configured). Display pushes show a banner; silent/data pushes trigger background sync.

- Never put sensitive data in the payload: send "New message", the app fetches content.
- Tokens change: re-register on every start, store several per user (multiple devices), delete tokens the provider reports invalid.
- Batch, dedupe, respect quiet hours and time zones, segment by preference.
- Push taps open a deep link to the content.

## Offline sync

| Data | Strategy |
|------|----------|
| Read-only (catalog, news) | Cache + TTL, ETag/Last-Modified |
| User-owned (notes, todos) | Last-write-wins or timestamp merge |
| Collaborative | CRDT or OT, or Firebase/Supabase |
| Critical (payments, inventory) | Server-wins, optimistic UI + server confirmation |

Client queue: write to local DB, enqueue `{action, data, timestamp, retries}`, process FIFO when online, retry with backoff (max 5), resolve conflicts with the chosen strategy, then apply the server's merged state. Server accepts the client timestamp, compares versions and returns the merged result.

## Testing

| Testing | Tool |
|---------|------|
| Pure logic, stores, transformers | Jest |
| Components (render, tap, loading/error/empty states, labels) | React Native Testing Library, `flutter_test` widget tests |
| Components with navigation/context | RNTL with providers, Flutter `integration_test` |
| Critical journeys (login, purchase, deep links, push, permissions, offline to online) | Detox (RN), Maestro (both, YAML); Appium only as a last resort |
| Performance | Flashlight (RN), Flutter DevTools, Xcode / Android Studio profilers on device |

The model tends to: test with Jest only, use Enzyme (deprecated), use Cypress or browser E2E (can't reach native features), mock everything, skip platform-specific and performance tests, test only the happy path, chase 100% unit coverage.

Rough pyramid: 40% unit, 30% component, 20% integration, 10% E2E on real devices. Snapshot only key components; don't test styling or library internals. A flaky E2E test is worse than none.

Test on both platforms where they differ: back navigation, permissions (iOS asks once then Settings; Android can ask again with a rationale), keyboard, push payloads (APNs vs FCM), Universal Links vs App Links, custom pickers and gestures.

Offline cases: start offline, drop mid-action (queued, not lost), reconnect (synced, no duplicates), slow 2G (timeouts, loading states), flaky network (retries). Tools: mocked NetInfo in unit tests, Detox `device.setURLBlacklist()`, Charles Proxy or Network Link Conditioner manually.

Accessibility: labels on interactive elements, images labelled or marked decorative, button roles, target sizes, AA contrast; jest-axe or the Flutter accessibility checker, then a full pass with VoiceOver/TalkBack, large text and reduced motion.

CI: unit + component on every PR, integration on simulators at merge, E2E on real devices (Firebase Test Lab, AWS Device Farm, BrowserStack, or local devices) before release and nightly.

## Debugging

Don't debug with console.log. JS-side: React Native DevTools (console, sources, network, memory), Reactotron (state, API calls), Expo element inspector. Native side: `adb logcat` and Android Studio Layout Inspector; Xcode console and View Debugger.

- Red screen: JS error, read the stack trace.
- Crash to home screen: native (module failure, out of memory, missing permission declaration). `adb logcat *:E`, or Xcode, Window, Devices, device logs. Crash on launch is almost always native config (Info.plist, AndroidManifest.xml).
- Network: React Native DevTools or Reactotron; Charles/Proxyman sees native SDK traffic too but needs a certificate on the device (and fails against pinning).
- Lag: measure, don't guess. RN Performance Monitor (dev menu), Android "Profile GPU Rendering". JS FPS drop means heavy JS work; UI FPS drop means too many views or heavy images.
- Android: emulator `localhost` is `10.0.2.2`; Gradle sync failures are usually a Java version mismatch or duplicate classes; `./gradlew clean`.
- iOS: `pod deintegrate && pod install`; signing errors are Team ID or Bundle ID; Product, Clean Build Folder.
- Reinstalling node_modules rarely helps; clean the native build. "Works on the simulator" proves little: real devices expose hardware and concurrency bugs.
