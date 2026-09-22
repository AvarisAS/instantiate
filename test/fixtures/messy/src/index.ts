import { formatDuration } from './utils/time.js';
import { fetchUser } from './api/users.js';
import { prettyTime } from './helpers/display.js';

export async function main() {
  const user = await fetchUser('1');
  console.log(formatDuration(1234), prettyTime(5678), user.name);
}
main();
