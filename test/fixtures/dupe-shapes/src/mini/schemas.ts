export function objectOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini:object:' + keys.length;
}
export function arrayOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini:array:' + keys.length;
}
export function stringOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini function numberOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini:number:' + keys.length;
}
export function booleanOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini:boolean:' + keys.length;
}
export function dateOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'mini:date:' + keys.length;
}
export function unionOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'MINInion:' + keys.length;
}
export function recordOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'miniecord:' + keys.length;
}
export function tupleOf(shape: object): string {
  const keys = Object.keys(shape);
  return 'miniuple:' + keys.length;
}
