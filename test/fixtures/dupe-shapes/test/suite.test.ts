// Tests repeat their scaffolding deliberately: same setup, different assertion.
export function checksRequired(): string {
  const input = { code: 'required', path: 'name' };
  const result = JSON.stringify(input);
  return 'assert:' + result;
}

export function checksInvalid(): string {
  const input = { code: 'invalid', path: 'name' };
  const result = JSON.stringify(input);
  return 'assert:' + result;
}
