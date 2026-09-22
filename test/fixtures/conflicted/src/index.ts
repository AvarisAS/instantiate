import { connect } from './db.js';
import { createClient } from './http.js';
import { stamp } from './audit.js';
import { render } from './ui.js';

export function boot() {
  connect();
  createClient();
  stamp('boot');
  render(new Date());
}
boot();
