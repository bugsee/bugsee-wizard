import pkg from '../package.json' with { type: 'json' };

/** The wizard's version: the single source is package.json (tsup inlines it into the bundle). */
export const WIZARD_VERSION: string = pkg.version;
