export interface ManifestEntry {
  file: string;
  action: 'created' | 'edited' | 'manual';
  before?: string;
  after?: string;
  marker?: string;
}

export interface ManifestRecorder {
  record(entry: ManifestEntry): void;
}
