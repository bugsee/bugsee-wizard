import { describe, expect, it } from 'vitest';

import { detectProcessConfig } from '../../src/recipes/android/process-config.js';

describe('detectProcessConfig', () => {
  it('returns nulls/empties for a single-process manifest', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="MyApp">
        <activity android:name=".MainActivity" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBeNull();
    expect(result.componentProcesses).toEqual([]);
  });

  it('detects an application-wide custom process', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="MyApp"
        android:process=":custom">
        <activity android:name=".MainActivity" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBe(':custom');
    expect(result.componentProcesses).toEqual([]);
  });

  it('collects per-component custom processes', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="MyApp">
        <activity android:name=".MainActivity" />
        <service android:name=".PushService" android:process=":push" />
        <service android:name=".SyncService" android:process=":sync" />
        <provider android:name=".FileProvider" android:process=":push" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBeNull();
    // Order is insertion order in the matchAll walk; dedupe leaves :push once.
    expect(new Set(result.componentProcesses)).toEqual(new Set([':push', ':sync']));
  });

  it('handles both application + component processes simultaneously', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="MyApp"
        android:process=":app">
        <service android:name=".PushService" android:process=":push" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBe(':app');
    expect(result.componentProcesses).toEqual([':push']);
  });

  // B1 regression — `<activity-alias>` must not match the `<activity>` rule.
  it('does not match <activity-alias> as <activity>', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity-alias android:name=".LauncherAlias" android:process=":alias" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.componentProcesses).toEqual([]);
  });

  // C1 regression — single-quoted attribute values are valid XML.
  it('detects android:process with single quotes', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:process=':app'>
        <service android:name=".S" android:process=':svc' />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBe(':app');
    expect(result.componentProcesses).toEqual([':svc']);
  });

  // C2 regression — XML comments are stripped before scanning.
  it('ignores android:process inside XML comments', () => {
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <!-- <activity android:name=".Disabled" android:process=":fake" /> -->
        <activity android:name=".RealActivity" />
    </application>
</manifest>`;
    const result = detectProcessConfig(manifest);
    expect(result.applicationProcess).toBeNull();
    expect(result.componentProcesses).toEqual([]);
  });

  // C3 regression — empty / whitespace-only process value is treated as absent.
  it('treats empty or whitespace-only process attributes as absent', () => {
    const manifestEmpty = `<application android:process=""></application>`;
    const manifestSpaces = `<application android:process="   "></application>`;
    expect(detectProcessConfig(manifestEmpty).applicationProcess).toBeNull();
    expect(detectProcessConfig(manifestSpaces).applicationProcess).toBeNull();
  });
});
