var test = require('node:test');
var assert = require('node:assert/strict');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');

// Only pure calculation/rendering modules are loaded. Fixtures are created here;
// neither the application server nor the persistence module is imported.
function item(overrides) {
  return Object.assign({ id: 1, name: 'Test item', sku: 'TEST-1',
    hsn: '0902', price: 100, qty: 1 }, overrides);
}

function billedOrder(items, coupon) {
  var totals = pricing.computeTotals(items, coupon || '');
  return {
    id: 1, date: '01/01/2022', customer: 'Test customer',
    paymentMode: 'cash', status: 'completed', items: items,
    coupon: coupon || '', subtotal: totals.subtotal,
    discount: totals.discount, tax: totals.tax, total: totals.total
  };
}

function figures(order) {
  var result = invoice.computeInvoiceFigures(order);
  return [result.subtotal, result.discount, result.tax,
    result.cgst, result.sgst, result.total];
}

test('regression: rice with SAVE10 prints the billed total and discounted 5% GST', function () {
  var order = {
    id: 1009, date: '01/01/2022', customer: 'Test customer',
    paymentMode: 'cash', status: 'completed', coupon: 'SAVE10',
    items: [item({ hsn: '1006', price: 640 })],
    subtotal: 640, discount: 64, tax: 28.8, total: 604.8
  };
  assert.deepEqual(figures(order), [640, 64, 28.8, 14.4, 14.4, 604.8]);
  assert.deepEqual(invoice.computeInvoiceFigures(order).rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 28.8]]);
  var html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td[^>]*>[^<]*604\.80/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*28\.80/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
});

test('18% item without a coupon matches the billed total and splits GST', function () {
  var order = billedOrder([item()]);
  assert.equal(order.total, 118);
  assert.deepEqual(figures(order), [100, 0, 18, 9, 9, 118]);
  assert.deepEqual(invoice.computeInvoiceFigures(order).rows, [{
    name: 'Test item', sku: 'TEST-1', hsn: '0902', qty: 1,
    price: 100, gstPercent: 18, line: 100, lineTax: 18
  }]);
});

test('invoice uses mixed HSN slabs just like checkout', function () {
  var order = billedOrder([
    item({ hsn: '1006' }), item({ id: 2, hsn: '0405' }), item({ id: 3 })
  ]);
  assert.equal(order.tax, 35);
  assert.equal(order.total, 335);
  assert.deepEqual(figures(order), [300, 0, 35, 17.5, 17.5, 335]);
  assert.deepEqual(invoice.computeInvoiceFigures(order).rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 5], [12, 12], [18, 18]]);
});

test('percentage discount reduces taxable value and preserves billed GST', function () {
  var order = billedOrder([item({ price: 1000 })], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [100, 162, 1062]);
  assert.deepEqual(figures(order), [1000, 100, 162, 81, 81, 1062]);
});

test('invoice respects the SAVE10 discount cap', function () {
  var order = billedOrder([item({ price: 2000 })], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual(figures(order), [2000, 150, 333, 166.5, 166.5, 2183]);
});

test('flat discount reduces invoice GST just like checkout', function () {
  var order = billedOrder([item({ price: 400 })], 'FLAT50');
  assert.deepEqual([order.discount, order.tax, order.total], [50, 63, 413]);
  assert.deepEqual(figures(order), [400, 50, 63, 31.5, 31.5, 413]);
});

test('invoice ignores inactive and below-minimum coupons just like checkout', function () {
  var expired = billedOrder([item({ price: 1000 })], 'DIWALI20');
  assert.deepEqual([expired.discount, expired.total], [0, 1180]);
  assert.deepEqual(figures(expired), [1000, 0, 180, 90, 90, 1180]);

  var belowMinimum = billedOrder([item()], 'SAVE10');
  assert.deepEqual([belowMinimum.discount, belowMinimum.total], [0, 118]);
  assert.deepEqual(figures(belowMinimum), [100, 0, 18, 9, 9, 118]);
});

test('below-minimum flat coupon leaves the invoice total positive and unchanged', function () {
  var order = billedOrder([item({ price: 10 })], 'FLAT50');
  assert.equal(order.total, 11.8);
  assert.deepEqual(figures(order), [10, 0, 1.8, 0.9, 0.9, 11.8]);
});

test('explicit percentage gstRate is used by the invoice', function () {
  var order = billedOrder([item({ gstRate: 12 })]);
  assert.equal(order.total, 112);
  assert.deepEqual(figures(order), [100, 0, 12, 6, 6, 112]);
});

test('invoice handles fractional and zero gstRate just like checkout', function () {
  var fractional = billedOrder([item({ gstRate: 0.05 })]);
  assert.equal(fractional.total, 105);
  assert.deepEqual(figures(fractional), [100, 0, 5, 2.5, 2.5, 105]);
  assert.equal(invoice.computeInvoiceFigures(fractional).rows[0].gstPercent, 5);

  var zero = billedOrder([item({ gstRate: 0 })]);
  assert.equal(zero.total, 100);
  assert.deepEqual(figures(zero), [100, 0, 0, 0, 0, 100]);
});

test('invoice sums rounded line taxes just like checkout', function () {
  var order = billedOrder([item({ price: 0.03 }), item({ id: 2, price: 0.03 })]);
  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(figures(order), [0.06, 0, 0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual(invoice.computeInvoiceFigures(order).rows.map(function (row) {
    return row.lineTax;
  }), [0.01, 0.01]);
});

test('CURRENT BEHAVIOUR: rendering shows recalculated figures and warns only about total differences', function () {
  var mismatch = billedOrder([item({ hsn: '1006' })]);
  mismatch.total = 100;
  var html = invoice.render(mismatch);
  assert.match(html, /Invoice computed total \([^)]*105\.00\)/);
  assert.match(html, /Order Ledger recorded total \([^)]*100\.00\)/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*5\.00/);
  assert.match(html, /Accountant Reconciliation Notice:/);

  var equalTotal = billedOrder([item({ price: 1000 })], 'SAVE10');
  assert.equal(equalTotal.tax, 162);
  var equalHtml = invoice.render(equalTotal);
  assert.match(equalHtml, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*162\.00/);
  assert.doesNotMatch(equalHtml, /Accountant Reconciliation Notice:/);
  equalTotal.tax = 1;
  assert.doesNotMatch(invoice.render(equalTotal), /Accountant Reconciliation Notice:/);
});

test('CURRENT BEHAVIOUR: stored billed figures are ignored without mutating the order', function () {
  var order = billedOrder([item()]);
  order.subtotal = 1;
  order.discount = 2;
  order.tax = 3;
  order.total = 4;
  var before = JSON.stringify(order);
  assert.deepEqual(figures(order), [100, 0, 18, 9, 9, 118]);
  invoice.render(order);
  assert.equal(JSON.stringify(order), before);
});
