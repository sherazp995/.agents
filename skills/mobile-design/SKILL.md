---
name: mobile-design
description: Mobile-first design thinking and decision-making for iOS and Android apps. Touch interaction, performance patterns, platform conventions. Teaches principles, not fixed values. Use when building React Native, Flutter, or native mobile apps.
allowed-tools: Read, Glob, Grep, Bash
---

# Mobile Design

Mobile is not a small desktop: touch first, battery aware, platform respectful, offline capable. Design for the worst conditions (bad network, one hand, bright sun, low battery, low-end device).

## Audit script

Run it, don't read it: `python scripts/mobile_audit.py <project_path>` (touch targets, list and animation performance, navigation, typography in React Native and Flutter code).

## Reference files

Open the file for the task at hand.

| File | Read when |
|------|-----------|
| [platforms.md](platforms.md) | Building UI for iOS, Android or both: sizes, type scales, colors, components, navigation and gestures that differ |
| [performance.md](performance.md) | Lists, animations, memory, images, battery, release builds (React Native and Flutter) |
| [ux-patterns.md](ux-patterns.md) | Touch, thumb zone, haptics, navigation structure and deep links, typography and color rules |
| [backend-testing-debugging.md](backend-testing-debugging.md) | Mobile APIs, push, offline sync, auth tokens, testing strategy, debugging native crashes |

For React Native or Flutter, check both platform sections in `platforms.md` and note where they diverge.

## Settle the open choices first

Platform, framework, navigation, state management, offline needs and target devices shape every later decision. Read them from the repository and the request first, and ask the user, in one message, only about the ones still open.

| Aspect | Ask | Why |
|--------|-----|-----|
| Platform | iOS, Android, or both? | Affects every design decision |
| Framework | React Native, Flutter, or native? | Determines patterns and tools |
| Navigation | Tab bar, drawer, or stack? | Core UX decision |
| State | Zustand, Redux, Riverpod, BLoC? | Architecture foundation |
| Offline | Must it work offline? | Data strategy |
| Target devices | Phone only, or tablet too? | Layout complexity |

Other questions worth asking when vague: OTA updates without store review needed (Expo)? Identical UI on both platforms (Flutter)? Existing backend or auth? Enterprise (SSO, compliance) or consumer?

### Framework

```
OTA updates + rapid iteration + web/React team  -> React Native + Expo (EAS Update)
Pixel-identical custom UI on both platforms      -> Flutter
Deep native features (ARKit, HealthKit, sensors) -> SwiftUI / Kotlin + Compose
                                                    (both platforms: native + Kotlin Multiplatform for shared logic)
Existing RN or Flutter codebase/team             -> stay with it (RN bare workflow if needed)
MVP on a budget                                  -> cross-platform, not native
```

### State

| Need | React Native | Flutter |
|------|--------------|---------|
| Simple app | Zustand or useState/Context | Provider or setState |
| Mostly server data | TanStack Query + Zustand for UI state | Riverpod async |
| Large app, large team | Redux Toolkit + RTK Query | BLoC (more boilerplate) or Riverpod |
| Granular derived state | Jotai | Riverpod |
| Quick prototype | Zustand | GetX, with caution (messy at scale) |

Server state goes in a query library, UI state stays local first, one approach per project, never navigation state in app state.

### Storage

| Data | Where |
|------|-------|
| Tokens, passwords, keys | Keychain (iOS), EncryptedSharedPreferences (Android), expo-secure-store / react-native-keychain |
| Settings | UserDefaults, SharedPreferences, AsyncStorage / MMKV |
| Structured data | SQLite (expo-sqlite, sqflite), Realm, WatermelonDB for large sets |
| Large files | Documents/Caches dir, internal storage, expo-file-system |
| API cache | TanStack Query, Riverpod |

### Offline

| Need | Approach |
|------|----------|
| Nice to have | Cache last data, show stale with a "last updated" time (TanStack Query staleTime) |
| Core feature | Local DB as source of truth, queue actions, sync when online, conflict strategy |
| Real-time (chat, collaboration) | WebSocket + local queue, optimistic updates, or a sync engine (Firebase, Realm Sync, Supabase) |

### Auth

- Email/password: access token in memory, refresh token in secure storage, silent refresh.
- Social login: OAuth 2.0 + PKCE with platform SDKs and a deep link callback; App Store rules require Sign in with Apple (or an equivalent privacy-focused login) when an iOS app offers third-party login.
- Enterprise: OIDC/SAML through the system browser.
- Biometrics unlock a stored token; they never replace server auth, and need a PIN/password fallback.

## Default patterns to question

Asked for mobile work without direction, the model reaches for these. Check each against the project before using it.

| Default | Question | Alternative |
|---------|----------|-------------|
| Tab bar for every project | How many destinations? | 2: top tabs or stack; 6+: drawer or tab + drawer hybrid |
| Fixed 5 tabs | Are all equally important? | 3 tabs, a "More" tab |
| Bottom nav everywhere | Tablet support? | Navigation rail, list-detail |
| Hamburger menu | Is hidden navigation acceptable? | Visible tabs |
| Modals for everything | Is it a separate task? | Stack push for primary flows |
| Redux everywhere | How complex is the app? | Zustand, TanStack Query |
| Global state for everything | Is it really global? | Local state, lift when needed |
| Context Provider hell | Will re-renders hurt? | Zustand, Jotai |
| BLoC for every Flutter app | Is the boilerplate worth it? | Riverpod |
| FlatList by default | Is performance critical? | FlashList |
| windowSize=21, removeClippedSubviews always | Measured need? | Defaults until profiling says otherwise |
| ListView.builder with manual dividers | Separators? | ListView.separated |
| FAB bottom-right | Handedness, accessibility? | Respect settings |
| Pull-to-refresh on every list | Does this list change? | Only where needed |
| Bottom sheet for every modal | How much content? | Full-screen modal |
| Swipe actions only | Discoverable? | Visible button alternative |

Passing a checklist is not the goal: a 44pt target at an unreachable edge, an unmemoized FlatList, or "offline support" that only shows a generic error all pass and still fail.

## Anti-patterns

### Performance

| Never | Why | Instead |
|-------|-----|---------|
| ScrollView / ListView(children) for long lists | Renders every item, memory explodes | FlatList / FlashList / ListView.builder |
| Inline renderItem | New function each render, every item re-renders | `useCallback` + `React.memo` |
| Index keys | Wrong recycling on reorder | Stable ID from data |
| Skip getItemLayout / itemExtent | Async layout, janky scroll | Provide when item height is fixed |
| setState high in the tree | Rebuilds everything below | Targeted state, `const` widgets |
| `useNativeDriver: false` | Animation runs on the JS thread | `useNativeDriver: true` for transform and opacity; Reanimated for layout or color |
| console.log / print in release | Slows the JS thread, leaks data | Strip before release |
| Missing cleanup | Leaks, zombie listeners | Clear timers, listeners, subscriptions; dispose controllers |

### Touch and UX

| Never | Why | Instead |
|-------|-----|---------|
| Touch target under 44pt / 48dp | Missed taps | 44pt iOS, 48dp Android, hit area may exceed the visual |
| Under 8px between targets | Taps hit neighbours | 8 to 12px gap |
| Gesture-only actions | Undiscoverable, excludes motor-impaired users | Visible button alternative |
| No loading, error or offline state | Looks crashed, no recovery | Feedback, retry, cached data |
| Ignoring platform conventions | Breaks muscle memory | iOS feels iOS, Android feels Android |

### Security

| Never | Why | Instead |
|-------|-----|---------|
| Tokens in AsyncStorage | Plain text, readable on rooted devices | SecureStore / Keychain / EncryptedSharedPreferences |
| Hardcoded API keys | Extracted from APK/IPA | Keep secrets on the server, not in the bundle |
| No certificate pinning | MITM | Pin in production |
| Logging tokens or PII | Logs can be extracted | Never log them |

### Architecture

| Never | Why | Instead |
|-------|-----|---------|
| Business logic in UI | Untestable | Service layer |
| Deep links as an afterthought | Push and shares break, refactor later | Plan the URL scheme from day one |

## Unify vs diverge

Unify business logic, data layer and core features. Diverge where users have platform muscle memory:

| Element | iOS | Android |
|---------|-----|---------|
| Font | SF Pro | Roboto |
| Min touch target | 44 x 44pt | 48 x 48dp |
| Back | Edge swipe from left | System back button/gesture, predictive back |
| Icons | SF Symbols | Material Symbols |
| Action choices | Action sheet from bottom | Bottom sheet / dialog |
| Progress | Spinner | Linear or circular Material indicator |
| Pull to refresh | UIRefreshControl | SwipeRefreshLayout |
| Date pickers, alerts | Native iOS controls | Native Material dialogs |

## Checklists

Before starting: platform, framework, navigation, state, storage per data type, offline needs, auth flow, deep link scheme, target devices.

Every screen:
- [ ] Touch targets at least 44pt / 48dp, primary CTA in the thumb zone
- [ ] Loading, error with retry, empty and offline states
- [ ] Platform conventions and safe areas respected
- [ ] Back works, deep link to the screen planned

Before release:
- [ ] console.log removed, tokens in secure storage, pinning enabled
- [ ] Lists memoized with stable keys, cleanup on unmount/dispose
- [ ] Tested in a release build on a low-end real device
- [ ] Accessibility labels on every interactive element, largest text size tested
- [ ] Dark mode, VoiceOver/TalkBack, deep links and push navigation tested
