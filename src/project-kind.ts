export const PROJECT_KINDS = [
  'android',
  'ios',
  'react-native',
  'flutter',
  'javascript',
  'unknown',
] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  android: 'Android (native)',
  ios: 'iOS (native)',
  'react-native': 'React Native',
  flutter: 'Flutter',
  javascript: 'JavaScript / TypeScript',
  unknown: 'Other / unknown',
};
