import * as clack from '@clack/prompts';

import { CancelledError } from '../engine/noninteractive.js';

/** The interactive questions a JavaScript run may ask. A cancel (Ctrl-C) throws CancelledError. */
export interface Prompts {
  confirm(message: string): Promise<boolean>;
  select(message: string, options: readonly { value: string; label: string }[]): Promise<string>;
}

/* v8 ignore start -- thin clack adapter; the flows are tested through injected prompts */
export const clackPrompts: Prompts = {
  async confirm(message) {
    const v = await clack.confirm({ message, initialValue: true });
    if (clack.isCancel(v)) throw new CancelledError();
    return v;
  },
  async select(message, options) {
    const v = await clack.select<string>({ message, options: [...options] });
    if (clack.isCancel(v)) throw new CancelledError();
    return v;
  },
};
/* v8 ignore stop */
