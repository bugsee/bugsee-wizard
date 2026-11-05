import { launch } from '@bugsee/browser';
import { greeting } from './greeting';

launch('YOUR_APP_TOKEN');
document.body.textContent = greeting('e2e');
