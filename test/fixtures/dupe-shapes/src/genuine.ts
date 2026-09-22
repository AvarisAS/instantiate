// A realistic accidental duplicate: the same job written twice by people who
// could not find each other's version. The names differ, but the domain words
// survive, which is what makes it detectable at all.
export function renderInvoiceTotal(doc: { total: number }): string {
  const total = doc.total.toFixed(2);
  const currency = 'GBP';
  const formatted = total + ' ' + currency;
  return 'Total: ' + formatted;
}

export function formatReceiptTotal(record: { total: number }): string {
  const total = record.total.toFixed(2);
  const currency = 'GBP';
  const formatted = total + ' ' + currency;
  return 'Total: ' + formatted;
}
