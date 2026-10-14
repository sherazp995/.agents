# Touch, Navigation, Type and Color

## Touch targets

A finger contact is about 7mm, covers the target, and has no hover.

| Standard | Minimum | Recommended | Spacing |
|----------|---------|-------------|---------|
| iOS HIG | 44 x 44pt | 48pt+ | 8pt |
| Material | 48 x 48dp | 56dp+ | 8dp |
| WCAG 2.2 | 24 x 24px (2.5.8, AA); 44 x 44px (2.5.5, AAA); exceptions: inline text, user-controlled size, essential | 44px | |
| Primary CTA, destructive | | 56 to 64px | |

The visual may be smaller than the hit area; extend it with padding (`hitSlop` in React Native).

| Element | Visual | Hit area |
|---------|--------|----------|
| Icon button | 24 to 32px | 44 to 48px |
| Text link | any | 44px tall |
| List row | full width | 48 to 56px tall |
| Checkbox, radio | 20 to 24px | 44 to 48px |
| Close (X) | 24px | 44px minimum |

## Thumb zone

About half of users hold the phone one-handed. Bottom of screen is easy, middle is fine, top is a stretch; on phones over 6" the top 40% is a dead zone one-handed.

| Element | Place |
|---------|-------|
| Primary CTA, tab bar, FAB | Bottom |
| Content, secondary actions | Middle |
| Navigation, settings, back | Top |
| Destructive actions, dismiss/cancel | Top left (hard to hit by accident) |
| Confirm/Done | Top right or bottom |

For large phones, bring top actions down: bottom sheets, pull-down interfaces, FABs.

## Feedback

- Tap: visible change within 50ms (highlight, scale 0.95 to 0.98, Android ripple). Never nothing.
- Anything over 100ms: show progress, disable the button against double taps, use optimistic UI when safe.
- Destructive actions need confirmation or undo.
- Feedback under the finger is hidden: show it above the touch point, use a loupe for text selection.

## Gestures

Gestures are invisible; many users never find them. Every gesture is a shortcut with a visible alternative: swipe to delete also has a button or menu, pull to refresh also a refresh control, pinch also zoom buttons, drag and drop also select + move, shake or force touch also a button.

Before adding a gesture, check: how it's discovered (edge peek, drag handle, onboarding hint), what it means on each platform, whether VoiceOver/TalkBack and switch control users can do it, and that it doesn't conflict with system gestures (iOS edge swipe back, Android back gesture, home indicator swipe).

## Haptics

| iOS | Use |
|-----|-----|
| `selection` | Picker scroll, toggle |
| `light` / `medium` / `heavy` | Minor / standard / significant action |
| `success` / `warning` / `error` | Notification patterns for outcomes |

Android `HapticFeedbackConstants`: `CONFIRM`, `REJECT` (error), `LONG_PRESS`, `CLOCK_TICK` (scrub), `CONTEXT_CLICK`. Android `VibrationEffect`: `EFFECT_CLICK`, `EFFECT_HEAVY_CLICK`, `EFFECT_DOUBLE_CLICK`, `EFFECT_TICK`.

Use for taps, toggles, picker values, pull-to-refresh trigger, swipe thresholds, success, errors, destructive or payment actions. Don't use for every scroll position or list item, background events or passive displays (haptic fatigue).

## Cognitive load

- Interrupted micro-sessions: one primary action per screen, save state on background.
- Typing is slow: smart defaults, pre-fill, break long forms into steps.
- Fewer choices than desktop: max 5 tabs, about 5 options per menu level, most-used first, "More" for the rest.
- No hover: anything hidden behind hover on desktop needs a tap or nothing.
- Motor impairments: generous targets, no tight timeouts, undo, switch and voice control support.

## Navigation structure

| Situation | Pattern |
|-----------|---------|
| 3 to 5 equal top-level sections, frequent switching | Tab bar / bottom navigation |
| Deep hierarchy (settings, folders) | Stack |
| More than 5 destinations, or rarely used ones | Drawer (hidden, hurts discoverability) |
| Linear flow (onboarding, checkout) | Stack only |
| Tablet / foldable | Navigation rail + list-detail |
| 3 sections | Never a drawer |

Rules:
- Each tab keeps its own stack; switching back returns to where the user was (own navigator per tab in React Navigation, `IndexedStack` in Flutter). Never reset a tab stack on switch.
- Back always pops the stack, is never hijacked, and only confirms when discarding unsaved data.
- Push for drilling in within a context; modal for a separate self-contained task (create, settings, transaction), dismissed by X, swipe down, scrim tap (non-critical) or Android back. Never a modal for a primary flow.
- Max 3 to 4 levels of nesting.
- Persist current tab, scroll position, form drafts and recent stack; don't persist dialogs, transient UI or stale data. React Navigation: `initialState` + `onStateChange` on `NavigationContainer`.
- Shared element transitions: Flutter `Hero`, SwiftUI `matchedGeometryEffect`, Compose shared elements.

The model tends to: use modals for everything, forget tab state preservation, skip deep linking, override platform back, reset stacks on tab switch, ignore predictive back (Android 14+).

## Deep links

Plan them from day one: push notifications, shares, marketing, Spotlight and widgets all need them, and retrofitting means refactoring navigation.

- URL path mirrors navigation: `myapp://home/product/123/reviews`, plus Universal Links (iOS) / App Links (Android) on `https://`.
- Build the full stack: a link to a product puts Home at the root so back works.
- Auth-gated targets: save the destination, log in, then navigate there.
- Unknown targets: fall back to home with a message, never crash or show a blank screen.
- During an active session: push on top or ask, don't wipe the current stack.

## Typography

| Rule | Mobile value |
|------|--------------|
| Body | 16pt/sp preferred, 14 minimum |
| Secondary / captions | 12 to 14 / 11 to 12 |
| Smallest anything | 11pt/sp |
| Line length | 40 to 60 characters |
| Line height | Body 1.4 to 1.6, headings 1.2 to 1.3, never below 1.2 |
| Sizes in a scale | 5 to 7 max |
| Weight | Regular dominant; all caps for headlines only |

WCAG 1.4.12 text spacing: line height 1.5x, paragraph spacing 2x, letter spacing 0.12x, word spacing 0.16x must not break layout. At large text sizes, avoid fixed heights, allow wrapping, scale icons with text, make long text scroll.

Custom fonts: subset (full 100 to 300KB per weight, Latin subset 15 to 40KB), 2 to 3 files max or one variable font, fall back to the system font, test at every Dynamic Type size.

Dark mode text looks thinner (halation): consider medium weight for body, test on OLED. Use off-white (#E0E0E0 to #F0F0F0), not pure white, on dark.

The model tends to: use fixed px instead of pt/sp, skip Dynamic Type, use 12 to 14px body text, ignore line height, use low-contrast "aesthetic" grays, apply desktop scales to mobile, skip large-text testing.

## Color

Priorities in order: readability outdoors, OLED battery, system light/dark integration, semantic meaning, brand.

- Contrast (WCAG AA): 4.5:1 normal text, 3:1 large text (18pt+, or 14pt bold) and UI components; aim for 7:1 (AAA). #999 on #FFF fails. Sunlight washes out light grays, pastels, low-opacity overlays and subtle gradients.
- Never rely on color alone (about 8% of men are colorblind): pair status colors with icons or text, avoid red/green-only distinctions.
- Don't invert light mode: desaturate, use lighter tints for emphasis, recheck contrast.
- OLED: black pixels are off. True black #000000 saves most but can smear while scrolling; near black #121212 to #1A1A1A is smoother. Background #000000, surfaces #0D0D0D to #1A1A1A (or Material #121212, #1E1E1E, #2C2C2C).
- Dark text: primary #E0E0E0 to #E8E8E8, secondary #A0A0A0 to #B0B0B0, disabled #606060 to #707070.
- Semantic colors are not brand colors. iOS error #FF3B30 (dark #FF453A), success #34C759, warning #FF9500, info #007AFF; Material error #B3261E (dark #F2B8B5).
- Test with Xcode Accessibility Inspector, Android Accessibility Scanner, a colorblind simulator, and a real device in sunlight.

The model tends to: use the same colors for light and dark, ignore OLED, skip contrast checks, default to purple/violet, use low-contrast grays, forget colorblind users.
