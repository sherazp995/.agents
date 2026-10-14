# iOS and Android

Users expect each platform's conventions; deviating feels broken. When in doubt, use the native component. Use semantic/system colors and system type styles so dark mode and text scaling come for free.

## Sizes and layout

| | iOS | Android |
|---|-----|---------|
| Unit | pt | dp for layout, sp for text (always) |
| Min touch target | 44 x 44pt | 48 x 48dp, even when the visual is smaller (24dp icon, 20dp checkbox) |
| Spacing between targets | 8pt | 8dp |
| Grid | 8pt multiples, 16pt screen margins (8pt compact, 20pt+ iPad) | 8dp baseline (4dp half-step), 16dp margins on phones, 24dp on medium/expanded |
| Tab / bottom bar | 49pt (83pt with home indicator), 3 to 5 items, 25 x 25pt icons, labels always | 80dp, 3 to 5 items, 24dp icons, labels always, active = filled icon + pill |
| Top bar | Nav bar 44pt, back chevron + previous title, max 2 right actions, large title collapses | Small top app bar 64dp, max 3 action icons then overflow menu |
| Text field | 36pt min height | 56dp, filled or outlined, floating label |
| Button | 44pt min height for primary CTAs | 40dp visual, 48dp touch; FAB 56dp (small 40, large 96), 16dp from edges |
| Sheet | Grabber, detents `.medium` / `.large` / custom | Modal sheet with scrim, 28dp top corners |
| Card | 16pt padding | 12dp radius, 16dp padding (elevated, filled, outlined) |
| Chips | n/a | 32dp height, 8dp radius (assist, filter, input, suggestion) |

Safe areas: never put interactive content under the status bar, notch/Dynamic Island or home indicator. Android 15 enforces edge-to-edge, so handle insets there too.

Android window size classes: compact < 600dp (one column, bottom nav), medium 600 to 840dp (two columns, navigation rail 80dp wide), expanded > 840dp (multi-column, drawer). Canonical layouts: list-detail, feed, supporting pane. iPad: sidebar, multi-column, popovers.

## Typography

iOS: SF Pro Text below 20pt, SF Pro Display at 20pt and above (automatic with system fonts), SF Mono, SF Pro Rounded. Android: Roboto, Roboto Flex (variable, API 33+), Roboto Mono.

iOS Dynamic Type styles:

| Style | Size | Weight | Line height |
|-------|------|--------|-------------|
| Large Title | 34pt | Bold | 41 |
| Title 1 / 2 / 3 | 28 / 22 / 20pt | Bold / Bold / Semibold | 34 / 28 / 25 |
| Headline | 17pt | Semibold | 22 |
| Body | 17pt | Regular | 22 |
| Callout / Subhead | 16 / 15pt | Regular | 21 / 20 |
| Footnote | 13pt | Regular | 18 |
| Caption 1 / 2 | 12 / 11pt | Regular | 16 / 13 |

Material 3 type scale (sp, size / line height):

| Role | Large | Medium | Small |
|------|-------|--------|-------|
| Display (400) | 57 / 64 | 45 / 52 | 36 / 44 |
| Headline (400) | 32 / 40 | 28 / 36 | 24 / 32 |
| Title | 22 / 28 (400) | 16 / 24 (500) | 14 / 20 (500) |
| Body (400) | 16 / 24 | 14 / 20 | 12 / 16 |
| Label (500) | 14 / 20 | 12 / 16 | 11 / 16 |

Text scaling is mandatory on both:

```swift
Text("Hello").font(.system(size: 17))                               // wrong: fixed
Text("Hello").font(.body)                                           // scales
Text("Hello").font(.custom("MyFont", size: 17, relativeTo: .body))  // custom font that scales
```

- iOS body runs from 14pt (xSmall) to 23pt (xxxLarge), and accessibility sizes reach 53pt.
- Android font scale runs 85% to 200%. Test at 200%, avoid fixed heights.
- In React Native, a fixed `fontSize` with scaling disabled is the same bug.

## Color

iOS semantic colors: `.label`, `.secondaryLabel`, `.tertiaryLabel`, `.quaternaryLabel`; `.systemBackground`, `.secondarySystemBackground`, `.tertiarySystemBackground`; `.systemFill` to `.quaternarySystemFill`.

| iOS system color | Light | Dark |
|------------------|-------|------|
| Blue (tint, links) | #007AFF | #0A84FF |
| Green (success) | #34C759 | #30D158 |
| Red (error, destructive) | #FF3B30 | #FF453A |
| Orange (warning) | #FF9500 | #FF9F0A |

Android Material roles: Surface, SurfaceVariant, InverseSurface (snackbars), OnSurface, OnSurfaceVariant, Outline, Primary / OnPrimary / PrimaryContainer / OnPrimaryContainer, same pattern for secondary, tertiary and error. Error: #B3261E light, #F2B8B5 dark (OnError #601410, ErrorContainer #8C1D18 dark).

Dynamic color (Android 12+) derives the scheme from the wallpaper; provide a static fallback for older Android or when disabled:

```kotlin
MaterialTheme(colorScheme = dynamicColorScheme() ?: staticColorScheme())
```

Material dark theme: background #121212 (not pure black), higher elevation = lighter surface overlay (1dp 5%, 3dp 8%, 6dp 11%, 8dp 12%, 12dp 14%), desaturated colors. iOS dark mode uses true black or near black, desaturated colors, glows instead of shadows.

## Navigation and gestures

| | iOS | Android |
|---|-----|---------|
| Back | Edge swipe from left; never break the interactive pop gesture | System back button/gesture; support predictive back (Android 14+); Up button optional |
| Top level | Tab bar, sidebar on iPad | Bottom navigation, rail on tablets, drawer for many destinations |
| Modals | Sheet (default, parent visible), full screen cover, popover (iPad), alert, action sheet | Bottom sheet, full-screen dialog, dialog (centered, scrim, max 2 actions right-aligned) |
| Dismiss modal | Swipe down | Back button or swipe |
| Context menu | Long press, preview + actions, destructive last in red, about 8 actions max | Long press |
| List swipe | Left: destructive (delete, archive, flag); right: constructive (pin, mark read); full swipe triggers first action | Swipe, immediate with undo snackbar |
| Share | Action sheet | Share sheet |
| Transient message | n/a | Snackbar: bottom above nav, 4 to 10s, max 2 lines, one text action, queue don't stack |
| Touch feedback | Highlight | Ripple on every touchable (about 12% black on light, 12% white on dark) |
| Push transition | Slide from right | Fade + slide |

Platform-native pull to refresh: UIRefreshControl and SwipeRefreshLayout; don't custom-build it.

## Components to reach for

- iOS: button styles tinted/bordered/plain, list styles `.insetGrouped` (default since iOS 14), `.plain`, `.grouped`, `.sidebar`; cell accessories disclosure (>), detail (i), checkmark; segmented control for 2 to 5 options, equal widths, text or icons not mixed.
- SF Symbols: match symbol weight to text weight, check availability on older iOS, `.symbolEffect` needs iOS 17.
- Android: filled / tonal / outlined / text buttons by emphasis; Material Symbols outlined, rounded or sharp, 24dp standard, disabled at 38% opacity, inactive outlined vs active filled.

## Accessibility

```swift
.accessibilityLabel("Play").accessibilityHint("Plays the selected track")
@Environment(\.accessibilityReduceMotion) var reduceMotion
```

```kotlin
Modifier.semantics { contentDescription = "Play"; role = Role.Button }
val reduceMotion = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
```

React Native: `accessibilityLabel`, `accessibilityHint`, `accessibilityRole`, `accessibilityState`, `AccessibilityInfo.isReduceMotionEnabled()`.

## Release checks

- iOS: dark mode, every text size (Accessibility Inspector), VoiceOver, edge swipe back everywhere, keyboard avoidance, notch/Dynamic Island and home indicator.
- Android: dark theme, dynamic color, 200% font scale, TalkBack, predictive back, edge-to-edge, phones and tablets, ripple on all touchables.
