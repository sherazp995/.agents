# Mobile Performance

The area where generated mobile code fails most. Frame budget: 16.67ms at 60fps, 8.33ms at 120fps (ProMotion). Never ship animations below 60fps.

## React Native

### Lists

`ScrollView` with `items.map` renders every item at once: 1,000 items is 1,000 renders, seconds of startup and exploding memory. Use FlatList, or FlashList (`@shopify/flash-list`, faster recycling, needs `estimatedItemSize`).

```tsx
const ListItem = React.memo(({ item }: { item: Item }) => (
  <Pressable style={styles.item}><Text>{item.title}</Text></Pressable>
));

const renderItem = useCallback(({ item }: { item: Item }) => <ListItem item={item} />, []);
const keyExtractor = useCallback((item: Item) => item.id, []);           // never the index
const getItemLayout = useCallback(
  (_: Item[] | null, index: number) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }),
  []
);                                                                        // only for fixed-height items

<FlatList
  data={items}
  renderItem={renderItem}
  keyExtractor={keyExtractor}
  getItemLayout={getItemLayout}
  removeClippedSubviews   // detaches off-screen views
  maxToRenderPerBatch={10}
  windowSize={5}          // viewports rendered: 2 each side plus the visible one
  initialNumToRender={10}
/>
```

Impact: `React.memo`, memoized `renderItem` and stable keys are critical; `getItemLayout` and `removeClippedSubviews` high; batch and window sizes medium, tune only after profiling.

### Animation

```js
Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: true }).start();
```

The native driver handles only non-layout properties such as transform (translate, scale, rotate) and opacity. Width, height, margin, padding and similar layout props cannot use it; for those, background color, or gesture-driven animation, use Reanimated (`useSharedValue`, `useAnimatedStyle`, `withSpring`), which runs worklets on the UI thread.

### Leaks

```js
useEffect(() => {
  const id = setInterval(fetchData, 5000);
  return () => clearInterval(id);
}, []);
```

Sources: timers, event listeners, WebSocket/PubSub subscriptions, state updates after unmount (use AbortController), unbounded image caches.

## Flutter

- `setState` rebuilds the whole subtree. Add `const` constructors and `const` to every widget that doesn't depend on state; const children don't rebuild.
- Rebuild surgically: `ValueListenableBuilder` (its `child:` is not rebuilt), or Riverpod `ref.watch(provider.select((s) => s.name))` instead of watching the whole provider.
- Lists: `ListView.builder` (lazy) instead of `ListView(children: ...)`; `itemExtent` for fixed heights; `ListView.separated` for dividers.
- Images: `CachedNetworkImage` with `memCacheWidth`/`memCacheHeight` at about 2x display size, placeholder and error widget, instead of bare `Image.network`.
- Animation: `FadeTransition` instead of the `Opacity` widget; `TickerProviderStateMixin` for controllers; Impeller renderer.
- Dispose everything created in `initState` (controllers, text controllers, stream subscriptions) in `dispose()`, then call `super.dispose()`.
- No `print()` in production; measure in profile/release mode with the DevTools performance overlay.

## Both platforms

### Animate transform and opacity only

Width, height, top/left, margin, padding, animated border radius and shadow all force layout on each frame.

| Animation | Duration | Easing |
|-----------|----------|--------|
| Micro-interaction | 100 to 200ms | ease-out |
| Standard transition | 200 to 300ms | ease-out |
| Page transition | 300 to 400ms | ease-in-out |
| Complex | 400 to 600ms | ease-in-out |
| Skeleton loop | 1000 to 1500ms | linear |

Springs that feel natural: damping 10 to 20, stiffness 100 to 200, mass 0.5 to 2 (Reanimated `withSpring`, Flutter `SpringDescription`). Custom transitions stay under 300ms.

### Memory

Decoded image size = width x height x 4 bytes: 1080p is 8.3MB, 4K is 33.2MB, ten 4K images is 332MB and a crash. Resize to display size (2 to 3x for retina), cap caches. Profile with React Native DevTools memory tab, Xcode Instruments, Android Studio Profiler or Flutter DevTools.

### Battery

| Source | Mitigation |
|--------|------------|
| Screen | Dark mode on OLED (black pixels are off) |
| Continuous GPS | Significant-change location |
| Network | Batch requests, cache aggressively (radio wakes once) |
| Animations | Reduce on low battery |
| Background work | Defer non-critical |

Background limits: iOS background refresh is system-scheduled, background modes are for location, audio and VoIP, background tasks get about 30 seconds; use push for important updates. Android: WorkManager for deferrable work, foreground service only when visible to the user, respect Doze and batch.

### Network

Read from cache first, update from network (instant UI, works offline). Use ETag/If-None-Match, Cache-Control, stale-while-revalidate, gzip/brotli, field selection and pagination.

## Measuring

| Metric | Target |
|--------|--------|
| Frame rate | 60fps, no drops while scrolling |
| Cold start | under 2s |
| Time to interactive | under 3s |
| Screen transition | under 300ms |
| Memory | stable over extended use |

Simulators run faster and dev builds slower than reality. Test a release/profile build on a low-end Android (under $200) and an older iPhone (SE or 8), with real data (1,000+ list items) and slow 3G.
