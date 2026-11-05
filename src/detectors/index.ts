import { registerDetector } from '../core/detect.js';
import { androidDetector } from './android.js';
import { iosDetector } from './ios.js';
import { javascriptDetector } from './javascript.js';
import { reactNativeDetector } from './react-native.js';

let registered = false;

export function registerAllDetectors(): void {
  if (registered) return;
  // React Native first so its evidence is reported before the
  // platform-only detectors when running tests / debugging — the actual
  // mutual-exclusivity guarantee is in each detector's logic, not in
  // registration order.
  registerDetector(reactNativeDetector);
  registerDetector(androidDetector);
  registerDetector(iosDetector);
  // After react-native: a `react-native` dependency makes this detector return null.
  registerDetector(javascriptDetector);
  registered = true;
}
