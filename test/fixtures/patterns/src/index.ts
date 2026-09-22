import { calledAtTopLevel, wrapper } from './helper.js';
import { viaNamedBarrel, viaStarBarrel } from './barrel.js';
import * as tags from './tags/index.js';
import vendored from '#vendored';
import { Machine } from './machine.js';

// A call at module scope: this has no enclosing function, and used to produce
// no edge at all, which made everything it reaches look unreachable.
const value = calledAtTopLevel();
console.log(value, wrapper(), viaNamedBarrel(), viaStarBarrel(), vendored);

// A namespace import indexed by a runtime key: no static graph can trace which
// export is used, so all of them must count as used.
const key = process.argv[2] ?? 'alpha';
console.log((tags as Record<string, () => string>)[key]?.());

new Machine().start();
