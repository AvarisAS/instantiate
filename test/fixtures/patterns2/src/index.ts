import { Widget } from './widget.js';
import { streams } from './shorthand.js';
import { registry } from './registry.js';
import type { Widget as WidgetType } from './types.js';

const widget: WidgetType = new Widget();
widget.resize(10);
console.log(widget.render(), streams(), registry.base);
