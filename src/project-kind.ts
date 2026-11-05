export const PROJECT_KINDS = [
  'android',
  'ios',
  'react-native',
  'flutter',
  'web',
  'unknown',
] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  android: 'Android (native)',
  ios: 'iOS (native)',
  'react-native': 'React Native',
  flutter: 'Flutter',
  web: 'Web / JavaScript',
  unknown: 'Other / unknown',
};
