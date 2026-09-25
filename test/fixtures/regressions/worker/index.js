import { ENCODING } from "./codec.js";

export default {
  async fetch() {
    return new Response(String(ENCODING));
  },
};
