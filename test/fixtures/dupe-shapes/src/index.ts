import { outerWithClosure } from './containment.js';
import { BaseThing, ConcreteThing } from './stubs.js';
import { head, options, remove } from './delegating.js';
import { objectOf as classicObjectOf } from './classic/schemas.js';
import { objectOf as miniObjectOf } from './mini/schemas.js';
import { renderInvoiceTotal, formatReceiptTotal } from './genuine.js';
import { AlbProcessor, GatewayProcessor } from './hierarchy/processors.js';
import { helpOption, versionOption } from './variants.js';

outerWithClosure(1);
new ConcreteThing().run();
console.log(BaseThing.name, head('a'), options('b'), remove('c'));
console.log(classicObjectOf({}), miniObjectOf({}));
console.log(renderInvoiceTotal({ total: 1 }), formatReceiptTotal({ total: 2 }));
console.log(new AlbProcessor().extract({}), new GatewayProcessor().extract({}));
console.log(helpOption('a'), versionOption('b'));
