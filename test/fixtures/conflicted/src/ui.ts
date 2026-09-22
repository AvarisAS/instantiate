export function render(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  return year + '/' + month + '/' + day;
}

export function label(date: Date) {
  return date.getHours() + ':' + date.getMinutes();
}
