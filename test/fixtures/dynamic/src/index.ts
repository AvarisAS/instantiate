import { Api } from './api';
import { dispatch } from './handlers';
import { load } from './i18n';

export async function main(): Promise<void> {
  new Api().call('get');
  dispatch('a');
  await load('en');
}
