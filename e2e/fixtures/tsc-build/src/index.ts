import { launch } from '@bugsee/node';
import { greeting } from './greeting.js';

const token = process.env.BUGSEE_APP_TOKEN;
if (token) launch(token);
console.log(greeting('e2e'));
