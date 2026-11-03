var grid = ee.FeatureCollection('projects/wildfire-risk-508811/assets/mtkenya_grid_1km');
var ba = ee.ImageCollection('MODIS/061/MCD64A1');

var perYear = ee.FeatureCollection(ee.List.sequence(2001, 2025).map(function (y) {
  y = ee.Number(y);
  var burnDate = ba.filter(ee.Filter.calendarRange(y, y, 'year'))
    .select('BurnDate').max();                    // day of year; 0 = not burned
  var period = burnDate.subtract(1).divide(8).floor().toInt()
    .updateMask(burnDate.gt(0)).rename('period'); // 8-day period index, 0 to 45
  return period.reduceRegions({
    collection: grid.select(['cell_id']),
    reducer: ee.Reducer.frequencyHistogram(),
    scale: 500,
    tileScale: 4
  }).map(function (f) { return f.set('year', y); });
})).flatten();

var fires = perYear.map(function (f) {
  var h = ee.Dictionary(ee.Algorithms.If(f.get('histogram'), f.get('histogram'), {}));
  return f.set('n_periods', h.size());
}).filter(ee.Filter.gt('n_periods', 0));

print('Cell-years with fire', fires.size());
print('Example', fires.first());

Export.table.toDrive({
  collection: fires.select(['cell_id', 'year', 'histogram'], null, false),
  description: 'mtkenya_fire_labels',
  fileFormat: 'CSV'
});