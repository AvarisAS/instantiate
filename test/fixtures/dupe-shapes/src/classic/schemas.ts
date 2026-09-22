export function objectOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic:object:' + keys.length;
}
export function arrayOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic:array:' + keys.length;
}
export function stringOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic function numberOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic:number:' + keys.length;
}
export function booleanOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic:boolean:' + keys.length;
}
export function dateOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classic:date:' + keys.length;
}
export function unionOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'CLASSICnion:' + keys.length;
}
export function recordOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classicecord:' + keys.length;
}
export function tupleOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'classicuple:' + keys.length;
}
