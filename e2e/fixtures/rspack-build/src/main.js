import { launch } from '@bugsee/browser';

launch('YOUR_APP_TOKEN');
// a second chunk, so the build emits more than one source map
import('./greeting.js').then(({ greeting }) => {
  document.body.textContent = greeting('e2e');
});
